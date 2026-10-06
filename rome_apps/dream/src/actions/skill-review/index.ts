import { sql } from "drizzle-orm";
import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AgentRunnerInterface,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

const log = createAppLogger("skill_review");

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<{ agentRunner: AgentRunnerInterface }>,
): Action {
  const { agentRunner, appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Webchat session ID to review. If omitted, the most recent session is used.",
        },
      },
      required: [],
    },
    async execute(args): Promise<ActionResult> {
      let sessionId = args.sessionId as string | undefined;

      if (!sessionId) {
        // rome_sessions also holds channel and background runs, including this
        // review's own agent session; keep to the old webchat_sessions rows.
        const row = appContext.db.connection.get(
          sql`
            SELECT id FROM rome_sessions
            WHERE type IN ('webchat', 'webchat_handoff')
            ORDER BY created_at DESC
            LIMIT 1
          `,
        ) as { id: string } | undefined;
        if (!row) {
          return { status: "ok", data: { result: "No webchat sessions found." } };
        }
        sessionId = row.id;
      }

      log.info("reviewing session", { sessionId });

      // Open an independent session so this review does not pollute the main
      // agent's conversation history. The skill-review agent fetches its own
      // conversation history via get_webchat_conversations.
      let result = "";
      for await (const msg of agentRunner.run({
        agentName: "skill-review",
        prompt:
          `Review webchat session ${sessionId} and decide whether to save a skill. ` +
          `Use get_webchat_conversations with sessionId: "${sessionId}" to fetch the conversation.`,
      })) {
        if (msg.type === "result") {
          result = msg.content as string;
        } else if (msg.type === "error") {
          log.error("skill-review agent failed", { error: msg.error });
          return { status: "error", error: `Skill-review agent failed: ${msg.error}` };
        }
      }

      return { status: "ok", data: { result } };
    },
  };
}
