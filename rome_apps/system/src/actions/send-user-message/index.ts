import { createAppLogger, defineAction, z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, ActionResult } from "@rome-os/app-runtime";
import type { SendUserMessageOutput } from "./types.js";
export type { SendUserMessageOutput } from "./types.js";

const log = createAppLogger("send-user-message");

// This action drives the same HTTP routes the dashboard composer uses, so the
// message is a real guardian turn — user-attributed transcript entry, session
// naming, /skill expansion, SSE stream — not a backend continuation. In-process
// callers hit the loopback listener, which resolves as the guardian by design
// (core lib/guardian-session.ts): the container is the security boundary.
function getInternalApiBaseUrl(): string {
  const port = process.env.INTERNAL_API_PORT?.trim() || "4141";
  return `http://127.0.0.1:${port}`;
}

export const sendUserMessageInputSchema = z.object({
  sessionMetadata: z
    .strictObject({
      isolated: z.boolean().optional(),
      purpose: z.string().trim().min(1).max(200).optional(),
      appId: z
        .string()
        .regex(
          /^(?:[a-z][a-z0-9-]{0,63}|@[a-z0-9][a-z0-9-]{0,30}[a-z0-9]\/[a-z0-9][a-z0-9_-]{0,62}[a-z0-9])$/,
        )
        .max(100)
        .optional(),
    })
    .optional()
    .describe(
      "Guardian-only, creation-only metadata: {isolated?: boolean, purpose?: string, appId?: string}. " +
        "An isolated chat omits memory/project prompt context and is excluded from dream self-review. " +
        "appId hides the creating app from its prompt catalog. Cannot be changed on an existing session. " +
        "This is not a filesystem sandbox.",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "The message, written exactly as the guardian would type it into the webchat composer " +
        "(markdown; a leading /skill-name invokes that skill, same as typed input).",
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      "Existing webchat session to continue. The turn runs on that session's own locked " +
        "agent, so `agentName` is ignored. Omit to start a new chat.",
    ),
  agentName: z
    .string()
    .optional()
    .describe(
      'Agent the new chat talks to (default "main"). Only read when `sessionId` is omitted; ' +
        "unknown agent names are rejected.",
    ),
  sessionName: z
    .string()
    .optional()
    .describe(
      "Display name for the new chat. Defaults to a name derived from the message text. " +
        "Only read when `sessionId` is omitted.",
    ),
  projectPath: z
    .string()
    .optional()
    .describe(
      "Webchat project the new chat works in (as shown in the dashboard's project picker). " +
        "Defaults to the default project. Only read when `sessionId` is omitted.",
    ),
});

export type SendUserMessageInput = z.infer<typeof sendUserMessageInputSchema>;

/** Test seam: override the HTTP transport without touching the environment. */
export interface SendUserMessageOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Non-JSON body (proxy error page, empty response) — fall through.
  }
  return `HTTP ${res.status}`;
}

export function createSendUserMessageAction(
  config: ActionConfig,
  options: SendUserMessageOptions = {},
): Action {
  return defineAction({
    config,
    schema: sendUserMessageInputSchema,
    execute: async (input): Promise<ActionResult> => {
      if (input.sessionId?.trim() && input.sessionMetadata !== undefined) {
        return {
          status: "error",
          error: "sessionMetadata is only accepted when creating a session",
        };
      }
      const fetchImpl = options.fetchImpl ?? fetch;
      const baseUrl = options.baseUrl ?? getInternalApiBaseUrl();

      let sessionId = input.sessionId?.trim();
      const createdSession = !sessionId;
      const sessionName = input.sessionName?.trim();

      if (!sessionId) {
        const agentName = input.agentName?.trim();
        const projectPath = input.projectPath?.trim();
        const res = await fetchImpl(`${baseUrl}/api/chat/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(agentName ? { agentName } : {}),
            ...(projectPath ? { projectPath } : {}),
            ...(input.sessionMetadata ? { sessionMetadata: input.sessionMetadata } : {}),
          }),
        });
        if (!res.ok) {
          return {
            status: "error",
            error: `Failed to create a webchat session: ${await readErrorMessage(res)}`,
          };
        }
        const session = (await res.json()) as { id?: unknown };
        if (typeof session.id !== "string" || !session.id) {
          return { status: "error", error: "Webchat session creation returned no session id" };
        }
        sessionId = session.id;
      }

      const res = await fetchImpl(
        `${baseUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: input.text }),
        },
      );
      if (!res.ok) {
        const detail = await readErrorMessage(res);
        // A session created above is left in place on failure — name it so the
        // caller can retry into it instead of minting another empty chat.
        return {
          status: "error",
          error: createdSession
            ? `Created webchat session ${sessionId} but failed to send the message: ${detail}`
            : `Failed to send the message to webchat session ${sessionId}: ${detail}`,
        };
      }
      const turn = (await res.json()) as { turnId?: unknown };
      const turnId = typeof turn.turnId === "string" ? turn.turnId : "";

      // The first turn on a fresh session auto-names it from the message text
      // (synchronously, before the turn POST responds), so an explicit name is
      // applied after the turn to stick. Best-effort: the message is already
      // delivered, so a rename failure downgrades to a warning, not an error.
      if (createdSession && sessionName) {
        const renamed = await fetchImpl(
          `${baseUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}/name`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: sessionName }),
          },
        );
        if (!renamed.ok) {
          log.warn("failed to name the created session", {
            sessionId,
            detail: await readErrorMessage(renamed),
          });
        }
      }

      log.info("sent guardian webchat message", { sessionId, turnId, createdSession });
      const data: SendUserMessageOutput = { sessionId, turnId, createdSession };
      return { status: "ok", data };
    },
    // Verbatim message text, like summon's prompt: the guardian must see the
    // words that will be said in their name, not a paraphrase. The raw session
    // UUID stays out of the card (same rule as send_message's threadId).
    preview: ({ text, sessionId, agentName }) => ({
      kind: "generic",
      title: sessionId
        ? "Continue a webchat conversation as the guardian"
        : "Start a webchat conversation as the guardian",
      summary: text,
      ...(sessionId ? {} : { fields: [{ label: "Agent", value: agentName?.trim() || "main" }] }),
    }),
  });
}

export function createAction(config: ActionConfig): Action {
  return createSendUserMessageAction(config);
}
