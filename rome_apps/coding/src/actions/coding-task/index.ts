import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

type CodingTaskDeps = AppActionRuntimeDeps;

export function createCodingTaskAction(config: ActionConfig, deps: CodingTaskDeps): Action {
  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          // Matches the blank-prompt rejection in execute, so a routine with a
          // blank prompt is rejected when it is created.
          minLength: 1,
          pattern: "\\S",
          description: "The coding task to hand off to the coding agent",
        },
        sessionId: {
          type: "string",
          description: "Optional session ID to resume an existing coding session",
        },
      },
      required: ["prompt"],
    },
    async execute(args: Record<string, unknown>): Promise<ActionResult> {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        return { status: "error", error: "prompt is required" };
      }

      const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
      return await deps.appContext.runAction("summon", {
        agentName: "coding",
        prompt,
        sessionId,
      });
    },
  };
}

export function createAction(config: ActionConfig, deps: CodingTaskDeps): Action {
  return createCodingTaskAction(config, deps);
}
