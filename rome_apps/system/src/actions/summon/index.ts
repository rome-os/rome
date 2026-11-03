import type {
  Action,
  ActionConfig,
  ActionResult,
  ActionExecutionContext,
  AgentRunnerInterface,
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
  workingDir: z
    .string()
    .optional()
    .describe(
      "Project directory the summoned agent works in: a path relative to the projects root " +
        "(e.g. `landingpage/content`) or an absolute path inside it. Must be an existing " +
        "directory. Defaults to the calling session's project.",
    ),
});

export type SummonInput = z.infer<typeof summonInputSchema>;

export interface SummonDeps {
  agentRunner: AgentRunnerInterface;
  resolveArtifactReference: (input: {
    kind: "agent" | "action";
    value: string;
  }) => string | Promise<string>;
  emitAgentMessage?: (message: StreamAgentMessage) => void;
}

/**
 * Creates the summon action, which runs a subagent's loop to completion and
 * returns its reply. The run works in `workingDir` when given, else in the
 * calling session's project; the host rejects a `workingDir` outside the
 * projects root.
 */
export function createSummonAction(config: ActionConfig, deps: SummonDeps): Action {
  return defineAction({
    config,
    schema: summonInputSchema,
    execute: async (
      { agentName, prompt, sessionId, workingDir },
      actionContext,
    ): Promise<ActionResult> => {
      const resolvedAgentName = await deps.resolveArtifactReference({
        kind: "agent",
        value: agentName,
      });
      const result = await executeSummon(
        deps,
        resolvedAgentName,
        prompt,
        sessionId,
        actionContext,
        workingDir,
      );
      return { status: "ok", data: result };
    },
    // The "action" a summon routine fires is an agent run, where the real
    // payload is the prompt the agent will be handed. Surface it verbatim so the
    // guardian sees the instruction that will execute, not a paraphrase of it.
    preview: ({ agentName, prompt }) => ({
      kind: "generic",
      title: `Run agent “${agentName}”`,
      summary: prompt,
    }),
  });
}

export function createAction(config: ActionConfig, deps: SummonDeps): Action {
  return createSummonAction(config, deps);
}

export async function executeSummon(
  deps: SummonDeps,
  agentName: string,
  prompt: string,
  sessionId?: string,
  actionContext?: ActionExecutionContext,
  workingDir?: string,
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
    let runError: string | undefined;
    let hasResult = false;
    let turnStarted = false;
    let turnStatus: "completed" | "interrupted" | "error" | undefined;

    for await (const msg of deps.agentRunner.run({
      agentName,
      prompt,
      sessionId,
      ...(workingDir !== undefined ? { workingDir } : {}),
      sharedContext: getCurrentActionContext()?.sharedContext,
    })) {
      // Lifecycle brackets describe the summoned agent's own stream, not the
      // caller's; keep them local and forward only content. session_init still
      // forwards — the trace UI keys the sub-agent header off it.
      if (msg.type === "turn_start") {
        turnStarted = true;
        resolvedSessionId = msg.sessionId;
        continue;
      }
      if (msg.type === "turn_end") {
        turnStatus = msg.status;
        continue;
      }

      if (msg.type === "session_init" && msg.romeSession && !romeSession) {
        romeSession = msg.romeSession;
        actionContext?.emitActionEvent<SummonSessionStartedEvent>({
          type: "rome_session_started",
          agentName,
          romeSession,
        });
      }

      if (msg.type === "error") runError ??= msg.error;

      deps.emitAgentMessage?.({ ...msg, agent: agentName });

      if (msg.type === "result") {
        hasResult = true;
        result = msg.content;
        if (Object.prototype.hasOwnProperty.call(msg, "structuredOutput")) {
          output = msg.structuredOutput;
        }
      }
    }

    if (!romeSession) {
      // A run the host refuses to start (an unknown agent, a rejected
      // `workingDir`) streams only an error; surface its reason.
      throw new Error(
        runError
          ? `Summoned agent "${agentName}" failed to start: ${runError}`
          : `Summoned agent "${agentName}" did not provide a durable Rome session`,
      );
    }

    // An abort can also emit an error block. The turn outcome owns cancellation.
    if (turnStatus === "interrupted") {
      throw new Error(`Summoned agent "${agentName}" was interrupted`);
    }
    if (runError !== undefined || turnStatus === "error") {
      throw new Error(
        `Summoned agent "${agentName}" failed: ${runError || "turn ended with an error"}`,
      );
    }
    if (!hasResult || (turnStarted && turnStatus === undefined)) {
      throw new Error(`Summoned agent "${agentName}" ended without a completed result`);
    }

    return {
      result,
      sessionId: resolvedSessionId,
      romeSession,
      ...(output !== undefined ? { output } : {}),
    };
  });
}
