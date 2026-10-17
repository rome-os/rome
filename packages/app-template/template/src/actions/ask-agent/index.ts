import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

const log = createAppLogger("__APP_ID__:ask_agent");

const askAgentInputSchema = z.object({
  prompt: z.string().trim().min(1).describe("Prompt to send to the demo agent"),
  sessionId: z.string().optional().describe("Optional session ID to resume the demo agent"),
});

type SummonData = {
  result?: unknown;
  sessionId?: unknown;
};

function readSummonData(data: unknown): { result: string; sessionId?: string } | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const summonData = data as SummonData;
  if (typeof summonData.result !== "string") {
    return null;
  }

  return {
    result: summonData.result,
    sessionId: typeof summonData.sessionId === "string" ? summonData.sessionId : undefined,
  };
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: askAgentInputSchema,
    execute: async ({ prompt, sessionId }) => {
      log.info("ask-agent invoked", { prompt, sessionId });

      const summonResult = await deps.appContext.runAction("system:summon", {
        agentName: "__APP_ID__:demo",
        prompt,
        sessionId,
      });

      if (summonResult.status !== "ok") {
        return summonResult;
      }

      const data = readSummonData(summonResult.data);
      if (!data) {
        return { status: "error", error: "Summon did not return a result string" };
      }

      return { status: "ok", data };
    },
  });
}
