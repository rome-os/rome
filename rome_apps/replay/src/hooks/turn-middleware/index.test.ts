import type {
  AgentMessage,
  AppLogger,
  TurnMiddlewareContext,
  TurnMiddlewareHookDeps,
} from "@rome-os/app-runtime";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createHook } from "./index.js";

const logger: AppLogger = {
  debug: rs.fn(),
  info: rs.fn(),
  warn: rs.fn(),
  error: rs.fn(),
};

function makeContext(agentName: string, emitted: AgentMessage[]): TurnMiddlewareContext {
  return {
    input: { prompt: "hello" },
    session: { id: "session-1", agentName, channelThreadKey: "webchat:session-1" },
    emit: (event) => emitted.push(event),
    meta: {},
  };
}

describe("replay turn middleware routing", () => {
  afterEach(() => {
    rs.clearAllMocks();
  });

  it("intercepts the app-owned canonical agent id", async () => {
    const emitted: AgentMessage[] = [];
    const next = rs.fn(async () => {});
    const deps: TurnMiddlewareHookDeps = { appId: "replay", logger };

    await createHook(deps).handle(makeContext("replay:replay", emitted), next);

    expect(next).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({ type: "result" });
  });

  it("does not intercept the same local name owned by another app", async () => {
    const emitted: AgentMessage[] = [];
    const next = rs.fn(async () => {});
    const deps: TurnMiddlewareHookDeps = { appId: "replay", logger };

    await createHook(deps).handle(makeContext("other-app:replay", emitted), next);

    expect(next).toHaveBeenCalledOnce();
    expect(emitted).toEqual([]);
  });
});
