import { describe, expect, it } from "@rstest/core";
import type { AgentSession, Sessions } from "../agent/index.js";
import { chatSessionKeyOf, workspaceSessions } from "./workspace-sessions.js";

/** Sessions that answer the key and opening each open asked for. */
function recording() {
  const opened: { key: string; audience?: string; env?: string }[] = [];
  const sessions = {
    async open(key, opening) {
      opened.push({
        key: key.channelThreadKey,
        ...(opening?.audience ? { audience: opening.audience } : {}),
        ...(opening?.toolEnv?.ROME_TURN_AUDIENCE
          ? { env: opening.toolEnv.ROME_TURN_AUDIENCE }
          : {}),
      });
      return {} as AgentSession;
    },
  } as Sessions;
  return { sessions, opened };
}

const serves = (connectionId: string) => connectionId === "slack";

function mention(chatId: string, connectionId = "slack") {
  return {
    threadContext: { channel: "slack_app", threadId: chatId, connectionId },
    audience: "private" as const,
  };
}

describe("workspaceSessions", () => {
  it("opens every chat of a workspace account in its one shared session", async () => {
    const { sessions, opened } = recording();
    const open = workspaceSessions(sessions, serves);
    await open.open(
      { agentName: "core:concierge", channelThreadKey: "slack_app:C1" },
      mention("C1"),
    );
    await open.open(
      { agentName: "core:concierge", channelThreadKey: "slack_app:D2" },
      mention("D2"),
    );
    expect(opened).toEqual([
      { key: "slack_app:*", audience: "shared", env: "shared" },
      { key: "slack_app:*", audience: "shared", env: "shared" },
    ]);
  });

  it("opens the account's session on the model it is given, at its effort", async () => {
    let asked: unknown;
    const sessions = {
      async open(_key, opening) {
        asked = { selectionId: opening?.selectionId, reasoningEffort: opening?.reasoningEffort };
        return {} as AgentSession;
      },
    } as Sessions;
    const open = workspaceSessions(sessions, serves, () => ({
      selectionId: "claude-opus-5-5",
      reasoningEffort: "low",
    }));
    await open.open(
      { agentName: "core:concierge", channelThreadKey: "slack_app:C1" },
      mention("C1"),
    );
    expect(asked).toEqual({ selectionId: "claude-opus-5-5", reasoningEffort: "low" });
  });

  it("opens a chat of any other account in its own session", async () => {
    const { sessions, opened } = recording();
    const open = workspaceSessions(sessions, serves);
    await open.open(
      { agentName: "main", channelThreadKey: "discord:C1" },
      { threadContext: { channel: "discord", threadId: "C1", connectionId: "discord" } },
    );
    expect(opened).toEqual([{ key: "discord:C1" }]);
  });

  it("opens a key that names no chat as asked", async () => {
    const { sessions, opened } = recording();
    const open = workspaceSessions(sessions, serves);
    await open.open(
      { agentName: "sentinel", channelThreadKey: "sentinel:slack_app:C1:U1" },
      mention("C1"),
    );
    expect(opened.map((o) => o.key)).toEqual(["sentinel:slack_app:C1:U1"]);
  });
});

describe("chatSessionKeyOf", () => {
  it("names the account's one session for a chat of a workspace account", () => {
    const keyOf = chatSessionKeyOf((channel) => (channel === "slack_app" ? "slack" : "tg"), serves);
    expect(keyOf({ channel: "slack_app", threadId: "C1" })).toBe("slack_app:*");
    expect(keyOf({ channel: "telegram", threadId: "42" })).toBe("telegram:42");
  });
});
