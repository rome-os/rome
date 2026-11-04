import { describe, expect, it } from "@rstest/core";
import { fakeChatReads } from "../test-support/fake-chat-reads.js";
import { guardianChats, heardSince } from "./chat-lines.js";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60 * 1000);
const telegram = { name: "telegram", kind: "telegram" };

describe("heardSince", () => {
  it("counts a guardian request on the dashboard, not an agent's answer", async () => {
    const answered = fakeChatReads([
      {
        chat: { sessionId: "d1" },
        lines: [{ role: "assistant", content: "hi", createdAt: at(5) }],
      },
    ]);
    const asked = fakeChatReads([
      { chat: { sessionId: "d1" }, lines: [{ role: "user", content: "hi", createdAt: at(5) }] },
    ]);

    expect(await heardSince(answered, at(60))).toBe(false);
    expect(await heardSince(asked, at(60))).toBe(true);
  });

  it("counts a line someone else said on one of Rome's accounts, not Rome's own", async () => {
    const said = (role: "assistant" | "notification") =>
      fakeChatReads([
        {
          chat: { sessionId: "t1", channel: telegram },
          lines: [{ role, content: "x", createdAt: at(5) }],
        },
      ]);

    expect(await heardSince(said("assistant"), at(60))).toBe(false);
    expect(await heardSince(said("notification"), at(60))).toBe(true);
  });

  it("leaves out a line said before the window", async () => {
    const reads = fakeChatReads([
      { chat: { sessionId: "d1" }, lines: [{ role: "user", content: "hi", createdAt: at(120) }] },
    ]);

    expect(await heardSince(reads, at(60))).toBe(false);
  });
});

describe("guardianChats", () => {
  it("leaves out a chat a visitor owns or asked in", async () => {
    const reads = fakeChatReads([
      { chat: { sessionId: "mine" }, lines: [{ role: "user", content: "a", createdAt: at(5) }] },
      {
        chat: { sessionId: "owned", ownerKey: "visitor:v1" },
        lines: [{ role: "user", content: "b", createdAt: at(5) }],
      },
      {
        chat: { sessionId: "asked" },
        lines: [{ role: "user", content: "c", createdAt: at(5), senderId: "visitor:v2" }],
      },
    ]);

    const chats = await guardianChats(reads, at(60));

    expect(chats.map((chat) => chat.sessionId)).toEqual(["mine"]);
  });
});
