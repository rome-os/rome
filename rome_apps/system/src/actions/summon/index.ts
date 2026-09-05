import type {
  Action,
  ActionConfig,
  ActionResult,
  ActionExecutionContext,
  AgentRunnerInterface,
  ChildSessions,
  RomeSessionRef,
  StreamAgentMessage,
} from "@rome-os/app-runtime";
import { defineAction, getCurrentActionContext, withRomeSpan, z } from "@rome-os/app-runtime";
import type { SummonOutput, SummonSessionStartedEvent } from "./types.js";
export type { SummonOutput, SummonSessionStartedEvent } from "./types.js";

export const summonInputSchema = z.object({
  agentName: z.string().describe("Name of the agent to summon (must match an agent YAML config)"),
  prompt: z.string().describe("The task/prompt to send to the summoned agent"),
  sessionId: z.string().optional().describe("Optional session ID to resume a previous session"),
  detached: z
    .boolean()
    .optional()
    .describe(
      "Start the agent in the background and return immediately with " +
        "{ sessionId, turnId }. The child keeps running after this turn ends, so " +
        "nothing here waits for its reply — poll `summon_status` with the returned " +
        "sessionId to read its status, final reply, and transcript, and `summon_stop` " +
        "to cut it short. Both work from any later turn of this agent, including a " +
        "later run of a routine. Pass `sessionId` alongside to give an existing " +
        "detached child a new prompt, which is rejected while that child is still " +
        "running. Cannot be combined with `interactive`.",
    ),
  workingDir: z
    .string()
    .optional()
    .describe(
      "Absolute directory the child works in; defaults to the caller's project " +
        "directory. Detached summons only — a blocking summon inherits the caller's " +
        "directory and rejects this field.",
    ),
  interactive: z
    .boolean()
    .optional()
    .describe(
      "Open the summon as a handoff instead of a blocking run: the caller suspends, the " +
        "guardian collaborates with the summoned agent in a child session, and the call " +
        "resolves when the agent hands back a result the guardian approves. Requires `render`.",
    ),
  handback: z
    .object({
      schema: z
        .record(z.string(), z.unknown())
        .describe(
          "JSON Schema the handback artifact must satisfy. The summoned agent gets a " +
            "`submit_output` tool validated against it; guardian approval of a valid " +
            "submission resolves the call with that payload.",
        ),
      validate: z
        .string()
        .optional()
        .describe(
          "Action the host runs on each schema-valid submission for app-specific checks. " +
            "Receives the candidate payload as input; must return { valid, errors? } in data. " +
            "Fail-closed and must be read-only.",
        ),
    })
    .optional()
    .describe("Result contract the summoned agent must satisfy to hand control back"),
  appId: z
    .string()
    .optional()
    .describe(
      "App that owns this handoff (required when `interactive`). Names the app the " +
        "child conversation belongs to; the host install-checks it. The handoff does " +
        "not mount a surface itself — the summoned agent brings one up via `show_app`.",
    ),
  handbackHint: z
    .string()
    .optional()
    .describe(
      "Appended to the resolution prompt the resumed caller receives; the literal token " +
        "<childSessionId> is replaced with the handoff's child session id.",
    ),
});

export type SummonInput = z.infer<typeof summonInputSchema>;

export interface SummonDeps {
  agentRunner: AgentRunnerInterface;
  /** Owner of detached children. Absent in a host that wires no detached
   * support, where `detached: true` fails with an explanation. */
  childSessions?: ChildSessions;
  resolveArtifactReference: (input: {
    kind: "agent" | "action";
    value: string;
  }) => string | Promise<string>;
  emitAgentMessage?: (message: StreamAgentMessage) => void;
}

/**
 * Creates the summon action, which spawns a subagent in the current project —
 * either blocking (run the agent loop to completion and return its reply) or
 * interactive (suspend the caller on a guardian conversation with the agent).
 */
export function createSummonAction(config: ActionConfig, deps: SummonDeps): Action {
  return defineAction({
    config,
    schema: summonInputSchema,
    execute: async (
      {
        agentName,
        prompt,
        sessionId,
        detached,
        workingDir,
        interactive,
        handback,
        appId,
        handbackHint,
      },
      actionContext,
    ): Promise<ActionResult> => {
      if (interactive && !appId) {
        return {
          status: "error",
          error: "interactive summon requires an `appId` (the app that owns the handoff).",
        };
      }
      if (detached && interactive) {
        return {
          status: "error",
          error:
            "summon cannot be both `detached` and `interactive`: an interactive summon " +
            "suspends the caller on a guardian conversation, which is what detached avoids.",
        };
      }
      // Refused rather than ignored on the blocking path: a caller that names a
      // directory and silently gets another one has no way to notice.
      if (workingDir !== undefined && !detached) {
        return {
          status: "error",
          error:
            "summon accepts `workingDir` only with `detached: true`; a blocking summon " +
            "runs the child in the caller's own directory.",
        };
      }

      const [resolvedAgentName, resolvedValidatorName] = await Promise.all([
        deps.resolveArtifactReference({
          kind: "agent",
          value: agentName,
        }),
        handback?.validate
          ? deps.resolveArtifactReference({
              kind: "action",
              value: handback.validate,
            })
          : undefined,
      ]);
      const resolvedHandback =
        handback && resolvedValidatorName
          ? { ...handback, validate: resolvedValidatorName }
          : handback;

      if (detached) {
        return await startDetachedSummon(deps, {
          agentName: resolvedAgentName,
          prompt,
          resumeSessionId: sessionId,
          workingDir,
        });
      }

      if (interactive) {
        // The caller suspends on this directive; the host mints the child session
        // and seeds `prompt` as the opening turn (payload.summary). No surface is
        // mounted here — the summoned agent brings one up via `show_app` when it
        // has something to show. Off-webchat, the shim relays `promptText` as prose.
        return {
          status: "handoff",
          handoff: {
            appId: appId!,
            promptText: prompt,
            agentName: resolvedAgentName,
            payload: { summary: prompt },
            handback: resolvedHandback,
            handbackHint,
          },
        };
      }
      const result = await executeSummon(deps, resolvedAgentName, prompt, sessionId, actionContext);
      return { status: "ok", data: result };
    },
    // The "action" a summon routine fires is an agent run, where the real
    // payload is the prompt the agent will be handed. Surface it verbatim so the
    // guardian sees the instruction that will execute, not a paraphrase of it.
    preview: ({ agentName, prompt, detached, interactive }) => ({
      kind: "generic",
      title: interactive
        ? `Hand off to “${agentName}”`
        : detached
          ? `Run agent “${agentName}” in the background`
          : `Run agent “${agentName}”`,
      summary: prompt,
    }),
  });
}

export function createAction(config: ActionConfig, deps: SummonDeps): Action {
  return createSummonAction(config, deps);
}

/**
 * Hands the child off to the host and returns as soon as it has ids — nothing
 * here iterates the agent's stream, so the caller's turn can end while the
 * child runs on. Every host-side refusal (no agent-session caller, a resumed
 * child that is still running or owned by another agent, a live-child cap, a
 * relative `workingDir`) comes back as an error result rather than a throw,
 * because a manager routine polling `summon_status` needs to read the reason
 * and move on.
 */
async function startDetachedSummon(
  deps: SummonDeps,
  input: {
    agentName: string;
    prompt: string;
    resumeSessionId: string | undefined;
    workingDir: string | undefined;
  },
): Promise<ActionResult> {
  if (!deps.childSessions) {
    return {
      status: "error",
      error: "detached summon is unavailable: this host wires no detached child sessions.",
    };
  }
  if (!getCurrentActionContext()?.romeSessionId) {
    return {
      status: "error",
      error:
        "detached summon needs an agent-session caller: a detached child is filed under the " +
        "calling agent session, and this action was not invoked from an agent turn.",
    };
  }
  try {
    const started = await deps.childSessions.startDetached(input);
    return {
      status: "ok",
      data: {
        mode: "detached",
        sessionId: started.sessionId,
        turnId: started.turnId,
        agentName: started.agentName,
      },
    };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeSummon(
  deps: SummonDeps,
  agentName: string,
  prompt: string,
  sessionId?: string,
  actionContext?: ActionExecutionContext,
): Promise<SummonOutput> {
  // Wraps the nested agent run in a dedicated `summon:{child}` span so the
  // subagent-tree view can filter `name LIKE 'summon:%'` directly. The
  // `action:summon` span stays as the
  // parent; the child agent's own `agent:{name}` span nests inside this.
  return withRomeSpan(`summon:${agentName}`, { "rome.summon.child_agent": agentName }, async () => {
    let result = "";
    let resolvedSessionId = sessionId ?? "";
    let romeSession: RomeSessionRef | undefined;
    let output: unknown;

    for await (const msg of deps.agentRunner.run({
      agentName,
      prompt,
      sessionId,
      sharedContext: getCurrentActionContext()?.sharedContext,
    })) {
      // Lifecycle brackets describe the summoned agent's own stream, not the
      // caller's; keep them local and forward only content. session_init still
      // forwards — the trace UI keys the sub-agent header off it.
      if (msg.type === "turn_start") {
        resolvedSessionId = msg.sessionId;
        continue;
      }
      if (msg.type === "turn_end") continue;

      if (msg.type === "session_init" && msg.romeSession && !romeSession) {
        romeSession = msg.romeSession;
        actionContext?.emitActionEvent<SummonSessionStartedEvent>({
          type: "rome_session_started",
          agentName,
          romeSession,
        });
      }

      deps.emitAgentMessage?.({ ...msg, agent: agentName });

      if (msg.type === "result") {
        result = msg.content;
        if (Object.prototype.hasOwnProperty.call(msg, "structuredOutput")) {
          output = msg.structuredOutput;
        }
      }
    }

    if (!romeSession) {
      throw new Error(`Summoned agent "${agentName}" did not provide a durable Rome session`);
    }

    return {
      result,
      sessionId: resolvedSessionId,
      romeSession,
      ...(output !== undefined ? { output } : {}),
    };
  });
}
