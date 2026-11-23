import { describe, expect, it } from "@rstest/core";
import { ConnectionStatusMarks } from "./connection-status.js";

const chat = { channel: "discord_app", threadId: "900" };

function marks(known = true) {
  const calls: string[] = [];
  const shown = new ConnectionStatusMarks({
    chatOf: async () => (known ? chat : null),
    add: async (_chat, key, emoji) => {
      calls.push(`+${emoji} ${key}`);
    },
    remove: async (_chat, key, emoji) => {
      calls.push(`-${emoji} ${key}`);
    },
  });
  return { shown, calls };
}

describe("a message's status on a platform", () => {
  it("shows 👀 while it works, takes it off once it has none, and turns ⚠️ when it fails", async () => {
    const { shown, calls } = marks();
    await shown.statusChanged("chat-1", "m1", "working");
    await shown.statusChanged("chat-1", "m1", "working");
    await shown.statusChanged("chat-1", "m1", null);
    await shown.statusChanged("chat-1", "m2", "working");
    await shown.statusChanged("chat-1", "m2", "failed");
    expect(calls).toEqual(["+👀 m1", "-👀 m1", "+👀 m2", "-👀 m2", "+⚠️ m2"]);
  });

  it("keeps each message's changes in order, however fast they come", async () => {
    const { shown, calls } = marks();
    await Promise.all([
      shown.statusChanged("chat-1", "m1", "working"),
      shown.statusChanged("chat-1", "m1", null),
    ]);
    expect(calls).toEqual(["+👀 m1", "-👀 m1"]);
  });

  it("shows nothing for a chat that is not on a connection", async () => {
    const { shown, calls } = marks(false);
    await shown.statusChanged("dashboard-chat", "m1", "working");
    expect(calls).toEqual([]);
  });
});
