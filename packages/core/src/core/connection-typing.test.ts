import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { connectionTyping, RENEW_MS } from "./connection-typing.js";

describe("a connected chat's typing indicator", () => {
  let shown: string[];
  const typing = () =>
    connectionTyping({
      typingOf: (channel) =>
        channel === "discord_app"
          ? async (chatId) => {
              shown.push(chatId);
            }
          : null,
    });
  const turn = (over: Record<string, unknown> = {}) => ({
    channel: "discord_app",
    threadId: "900",
    initiatedBy: "user",
    providerId: () => "anthropic",
    ...over,
  });

  beforeEach(() => {
    shown = [];
    rs.useFakeTimers();
  });
  afterEach(() => {
    rs.useRealTimers();
  });

  it("shows while the reply's text is written, again while it lasts, and stops when it lands", async () => {
    const one = typing()(turn());
    expect(one).not.toBeNull();
    one?.event({ type: "turn_start" });
    expect(shown).toEqual([]);
    one?.event({ type: "text_delta" });
    expect(shown).toEqual(["900"]);
    await rs.advanceTimersByTimeAsync(RENEW_MS);
    expect(shown).toEqual(["900", "900"]);
    one?.event({ type: "text" });
    await rs.advanceTimersByTimeAsync(RENEW_MS * 3);
    expect(shown).toHaveLength(2);
    one?.end();
  });

  it("stops when a tool is called or the turn ends", async () => {
    const one = typing()(turn());
    one?.event({ type: "text_delta" });
    one?.event({ type: "tool_use", id: "t1", tool: "chat_start" });
    await rs.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(shown).toHaveLength(1);
    one?.event({ type: "text_delta" });
    one?.end();
    await rs.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(shown).toHaveLength(2);
  });

  it("shows nothing where the dashboard's dots would show none", () => {
    // A provider that cannot say when it writes: the dashboard only holds a
    // message that has arrived, and a connection sends it at once.
    const simulated = typing()(turn({ providerId: () => "openai" }));
    simulated?.event({ type: "text_delta" });
    expect(shown).toEqual([]);
    // A turn no person started, such as a task's report.
    expect(typing()(turn({ initiatedBy: "system" }))).toBeNull();
    // The dashboard, and a channel whose account shows no typing.
    expect(typing()(turn({ channel: "webchat" }))).toBeNull();
    expect(typing()(turn({ channel: "slack_app" }))).toBeNull();
  });
});
