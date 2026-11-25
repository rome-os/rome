import { describe, expect, it } from "@rstest/core";
import type { Sessions } from "../agent/index.js";
import { AgentRunner } from "./agent-runner.js";

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
    undefined,
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

  it("opens the chat's own session where its scope is chat", async () => {
    const { runner, opened } = recordingRunner("chat");
    await runOnce(runner, "group");
    expect(opened.map((o) => o.key)).toEqual([
      { agentName: "core:concierge", channelThreadKey: "slack_app:D1" },
    ]);
  });
});
