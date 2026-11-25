import { context } from "@opentelemetry/api";
import { describe, expect, it, rs } from "@rstest/core";
import type { Sessions } from "../agent/index.js";
import { testReceipt, testTurnHandle } from "../test/turn-handle.js";
import { AgentRunner } from "./agent-runner.js";

/** What an opener states for a guardian's direct message: private. */
const privateOpening = async () => ({
  drawsCards: false,
  guardianFacing: true,
  toolEnv: { ROME_TURN_AUDIENCE: "private" },
  spanAttributes: {},
  audience: "private" as const,
});

/** A runner whose sessions record what each open asked for, and open none. */
function recordingRunner(scope: "chat" | "account") {
  const opened: { key: unknown; audience: unknown; turnAudience: unknown }[] = [];
  const sessions = {
    open: async (
      key: unknown,
      opening: { audience?: unknown; toolEnv?: Record<string, unknown> },
    ) => {
      opened.push({
        key,
        audience: opening.audience,
        turnAudience: opening.toolEnv?.ROME_TURN_AUDIENCE,
      });
      throw new Error("opened");
    },
  } as unknown as Sessions;
  const runner = new AgentRunner(
    sessions,
    { find: () => undefined } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    privateOpening,
    async () => scope,
  );
  return { runner, opened };
}

async function runOnce(runner: AgentRunner, threadType: "private" | "group") {
  const run = runner.run({
    agentName: "core:concierge",
    prompt: "hi",
    channelThreadKey: "slack_app:D1",
    platformMessageId: "m1",
    threadContext: {
      channel: "slack_app",
      connectionId: "slack-1",
      threadId: "D1",
      threadType,
      senderBondLevel: "guardian",
    },
  });
  await expect(run[Symbol.asyncIterator]().next()).rejects.toThrow("opened");
}

describe("the session a message's turn opens", () => {
  it("opens the account's one session, shared, where the chat's session scope is account", async () => {
    const { runner, opened } = recordingRunner("account");
    await runOnce(runner, "private");
    expect(opened).toEqual([
      {
        key: { agentName: "core:concierge", channelThreadKey: "slack_app:*" },
        audience: "shared",
        turnAudience: "shared",
      },
    ]);
  });

  it("opens the chat's own session, with the chat's own audience, where its scope is chat", async () => {
    const { runner, opened } = recordingRunner("chat");
    await runOnce(runner, "private");
    expect(opened).toEqual([
      {
        key: { agentName: "core:concierge", channelThreadKey: "slack_app:D1" },
        audience: "private",
        turnAudience: "private",
      },
    ]);
  });
});

describe("a session that answers every chat of its account", () => {
  it("opens shared when it is resumed by id, as an approval from a direct message resumes it", async () => {
    const resumed: { audience: unknown; turnAudience: unknown }[] = [];
    const sessions = {
      resume: async (
        _ref: unknown,
        opening: { audience?: unknown; toolEnv?: Record<string, unknown> },
      ) => {
        resumed.push({
          audience: opening.audience,
          turnAudience: opening.toolEnv?.ROME_TURN_AUDIENCE,
        });
        throw new Error("opened");
      },
    } as unknown as Sessions;
    const runner = new AgentRunner(
      sessions,
      { find: () => undefined } as never,
      { continuityKeyOfSession: async () => "slack_app:*" } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      privateOpening,
    );
    const run = runner.run({
      agentName: "core:concierge",
      prompt: "approved",
      sessionId: "account-session",
      threadContext: {
        channel: "slack_app",
        connectionId: "slack-1",
        threadId: "D1",
        threadType: "private",
        senderBondLevel: "guardian",
        romeSessionId: "rome-D1",
      },
    });
    await expect(run[Symbol.asyncIterator]().next()).rejects.toThrow("opened");
    expect(resumed).toEqual([{ audience: "shared", turnAudience: "shared" }]);
  });

  it("runs each chat's turn in that chat, not in the chat that opened the session", async () => {
    const turns: (string | undefined)[] = [];
    const session = {
      key: { agentName: "core:concierge", channelThreadKey: "slack_app:*" },
      sessionId: "account-session",
      status: "idle" as const,
      submit: rs.fn((input: { prompt: string }, options?: { romeSessionId?: string }) => {
        turns.push(options?.romeSessionId);
        return testReceipt(
          testTurnHandle({
            turnId: `turn-${turns.length}`,
            turnContext: context.active(),
            events: (async function* () {
              yield { type: "result", content: input.prompt, agent: "core:concierge" } as const;
            })(),
          }),
        );
      }),
      release: rs.fn(),
      onStatusChange: rs.fn(() => () => undefined),
      stop: rs.fn(async () => undefined),
      close: rs.fn(async () => undefined),
    };
    // Every chat's message opens the same live session.
    const sessions = { open: rs.fn(async () => session) } as unknown as Sessions;
    const runner = new AgentRunner(
      sessions,
      { find: () => undefined } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => "account",
    );
    const run = async (chat: string, romeSessionId?: string) => {
      for await (const _ of runner.run({
        agentName: "core:concierge",
        prompt: "hi",
        channelThreadKey: `slack_app:${chat}`,
        platformMessageId: `m-${chat}`,
        ...(romeSessionId ? { romeSessionId } : {}),
        threadContext: {
          channel: "slack_app",
          connectionId: "slack-1",
          threadId: chat,
          romeSessionId: `rome-${chat}`,
        },
      }));
    };
    await run("C1", "rome-C1");
    await run("C2", "rome-C2");
    // A turn whose caller names no chat, as a report does, runs in the chat
    // its thread names.
    await run("D3");
    expect(sessions.open).toHaveBeenCalledTimes(3);
    expect(turns).toEqual(["rome-C1", "rome-C2", "rome-D3"]);
  });
});
