import type {
  AgentMessage,
  AppLogger,
  TurnMiddlewareContext,
  TurnMiddlewareHookDeps,
} from "@rome-os/app-runtime";
import type { RomeAppContext } from "@rome-os/app-runtime";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import * as progressModule from "../../db/repositories/progress.js" with { rstest: "importActual" };

const mocks = rs.hoisted(() => ({
  row: { node: "done", sessionId: null as string | null },
  patch: rs.fn(),
}));

rs.mock("../../db/repositories/progress.js", () => ({
  ...progressModule,
  createProgressRepository: () => ({
    get: () => ({
      introRawInput: null,
      introSummary: null,
      ideas: [],
      ideasGeneratedAt: null,
      aiConnected: true,
      completedAt: null,
      ...mocks.row,
    }),
    patch: mocks.patch,
  }),
}));

import { createHook } from "./index.js";

const logger: AppLogger = {
  debug: rs.fn(),
  info: rs.fn(),
  warn: rs.fn(),
  error: rs.fn(),
};

function makeContext(
  agentName: string,
  emitted: AgentMessage[],
  channelThreadKey = "webchat:chat-1",
): TurnMiddlewareContext {
  return {
    input: { prompt: "hello" },
    // The AgentSession id and the chat id differ, as they do in core.
    session: { id: "agent-session-1", agentName, channelThreadKey },
    emit: (event) => emitted.push(event),
    meta: {},
  };
}

describe("welcome-to-rome turn middleware routing", () => {
  afterEach(() => {
    rs.useRealTimers();
    rs.clearAllMocks();
  });

  it("intercepts the app-owned canonical agent id", async () => {
    rs.useFakeTimers();
    const emitted: AgentMessage[] = [];
    const next = rs.fn(async () => {});
    const deps: TurnMiddlewareHookDeps = { appId: "welcome-to-rome", logger };
    const promise = createHook(deps).handle(
      makeContext("welcome-to-rome:welcome-to-rome", emitted),
      next,
    );

    await rs.runAllTimersAsync();
    await promise;

    expect(next).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({ type: "result" });
  });

  it("does not intercept the same local name owned by another app", async () => {
    const emitted: AgentMessage[] = [];
    const next = rs.fn(async () => {});
    const deps: TurnMiddlewareHookDeps = { appId: "welcome-to-rome", logger };

    await createHook(deps).handle(makeContext("other-app:welcome-to-rome", emitted), next);

    expect(next).toHaveBeenCalledOnce();
    expect(emitted).toEqual([]);
  });

  async function runWelcomeTurn(channelThreadKey: string): Promise<void> {
    rs.useFakeTimers();
    const appContext = {
      db: {},
      repositories: { settings: { get: rs.fn(async () => null), set: rs.fn() } },
    } as unknown as RomeAppContext;
    const deps: TurnMiddlewareHookDeps = { appId: "welcome-to-rome", logger, appContext };
    const promise = createHook(deps).handle(
      makeContext("welcome-to-rome:welcome-to-rome", [], channelThreadKey),
      rs.fn(async () => {}),
    );
    await rs.runAllTimersAsync();
    await promise;
  }

  it("records the chat the welcome run is taking turns in, not the agent session", async () => {
    mocks.row = { node: "done", sessionId: "older-chat" };

    await runWelcomeTurn("webchat:chat-1");

    expect(mocks.patch).toHaveBeenCalledWith({ sessionId: "chat-1" });
  });

  it.each([
    ["outside webchat", "telegram:123"],
    ["in a subagent of a chat", "webchat:chat-1:subagent:sub-1"],
    ["in a fork of a chat", "webchat:chat-1#fork:fork-1"],
  ])("records no chat for a turn %s", async (_label, channelThreadKey) => {
    mocks.row = { node: "done", sessionId: "older-chat" };

    await runWelcomeTurn(channelThreadKey);

    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.anything() }),
    );
  });
});
