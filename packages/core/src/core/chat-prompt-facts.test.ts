import { describe, expect, it, rs } from "@rstest/core";
import type { UnseenLine } from "../sessions/turn-links.js";
import { chatPromptFacts } from "./chat-prompt-facts.js";

const AMBIENT: UnseenLine = {
  id: 7,
  senderName: "Bob",
  account: { platform: "telegram", id: "bob" },
  text: "ambient update",
  at: new Date("2026-08-03T08:01:00.000Z"),
  fromRome: false,
  quoted: null,
  quotesOutside: false,
};

const CHANNELS: Record<string, string> = {
  "chat-quiet": "quiet",
  "chat-telegram": "telegram",
  "chat-unknown": "gone",
};

function facts() {
  const seen = rs.fn((_ids: readonly number[], _chatId: string, _turnId: string) => undefined);
  const promptFacts = chatPromptFacts({
    facts: { unseen: () => [AMBIENT], seen },
    messages: { byIds: () => [] },
    labels: {
      read: async () => [],
      readUnseen: async (lines) =>
        lines.map(({ senderName, account: _account, ...line }) => ({
          ...line,
          sender: senderName,
          who: "labelled",
          quoted: null,
        })),
    },
    channelOfChat: (chatId) => CHANNELS[chatId] ?? null,
    channelSurface: (channel) =>
      channel === "quiet"
        ? { interactiveCards: false, promptContext: false }
        : channel === "telegram"
          ? { interactiveCards: false, promptContext: true }
          : null,
  });
  return { promptFacts, seen };
}

describe("chatPromptFacts", () => {
  it("answers none in a chat whose channel hands the agent every message", async () => {
    expect(await facts().promptFacts.unseen("chat-quiet")).toBeNull();
  });

  it("answers the unseen messages in a chat whose channel does not, with who said them", async () => {
    const { promptFacts } = facts();
    const read = {
      id: 7,
      sender: "Bob",
      who: "labelled",
      text: "ambient update",
      at: AMBIENT.at,
      fromRome: false,
      quoted: null,
      quotesOutside: false,
    };
    expect(await promptFacts.unseen("chat-telegram")).toEqual([read]);
    // A channel name no channel has reads as a messaging channel's.
    expect(await promptFacts.unseen("chat-unknown")).toEqual([read]);
    // So does a chat no channel opened.
    expect(await promptFacts.unseen("chat-none")).toEqual([read]);
  });

  it("passes what a turn was shown through", () => {
    const { promptFacts, seen } = facts();
    promptFacts.seen([7], "chat-telegram", "turn-1");
    expect(seen).toHaveBeenCalledWith([7], "chat-telegram", "turn-1");
  });
});

describe("chatPromptFacts earlier messages", () => {
  const message = (minute: number, text = `message ${minute}`) => ({
    channel: "slack_app",
    chatId: "D1",
    messageId: `m${minute}`,
    direction: "inbound",
    senderId: "T_A/U_SAM",
    senderDisplayName: "Sam",
    text,
    attachments: [],
    timestamp: new Date(Date.UTC(2026, 7, 3, 8, minute)),
    account: { platform: "slack", id: "T_A/U_ROME" },
  });
  const earlierFacts = (
    page: unknown[],
    promptContext = true,
    keys: Record<number, string> = {},
  ) => {
    const read = rs.fn(async (lines: readonly { senderName: string | null; account: unknown }[]) =>
      lines.map((line) => ({ ...line, sender: line.senderName, who: "labelled" })),
    );
    const latest = rs.fn(async () => page as never);
    const promptFacts = chatPromptFacts({
      facts: { unseen: () => [], seen: () => undefined },
      messages: {
        byIds: (ids) => ids.flatMap((id) => (keys[id] ? [{ key: keys[id] } as never] : [])),
      },
      labels: { read: read as never, readUnseen: async () => [] },
      channelOfChat: () => null,
      channelSurface: () => ({ interactiveCards: false, promptContext }),
      latest,
    });
    return { promptFacts, latest, read };
  };
  const place = { channel: "slack_app", threadId: "D1", threadType: "private" as const };

  it("reads nothing in a group, where the platform holds what was said before Rome joined", async () => {
    const { promptFacts, latest } = earlierFacts([message(1)]);
    expect(
      await promptFacts.earlier?.({ ...place, threadId: "C1", threadType: "group" }, new Date()),
    ).toBeNull();
    expect(latest).not.toHaveBeenCalled();
  });

  it("reads nothing where the channel hands the agent every message", async () => {
    const { promptFacts, latest } = earlierFacts([message(1)], false);
    expect(await promptFacts.earlier?.(place, new Date())).toBeNull();
    expect(latest).not.toHaveBeenCalled();
  });

  it("keeps the latest 15 said before the turn, oldest first, each clipped", async () => {
    const page = Array.from({ length: 20 }, (_, i) => message(20 - i));
    page[1] = message(19, "x".repeat(900));
    const { promptFacts, read } = earlierFacts(page);
    // Message 20 is the one the turn answers.
    const earlier = await promptFacts.earlier?.(place, new Date(Date.UTC(2026, 7, 3, 8, 20)));
    expect(earlier?.map((m) => m.text.slice(0, 10))).toEqual([
      ...Array.from({ length: 14 }, (_, i) => `message ${i + 5}`),
      "x".repeat(10),
    ]);
    expect(earlier?.at(-1)?.text.length).toBe(501);
    // Its sender is the platform's account, for People to name.
    expect(read.mock.calls[0][0][0]).toMatchObject({
      senderName: "Sam",
      account: { platform: "slack", id: "T_A/U_SAM" },
    });
    expect(earlier?.every((m) => m.id < 0)).toBe(true);
  });

  it("names an outbound message as the platform names its sender, and Rome only where it names none", async () => {
    const outbound = (minute: number, senderDisplayName?: string) => ({
      ...message(minute),
      direction: "outbound",
      senderId: "T_A/U_ROME",
      senderDisplayName,
    });
    // On a personal account the guardian writes from Rome's account too.
    const { promptFacts, read } = earlierFacts([outbound(2, "Ouou"), outbound(1)]);
    await promptFacts.earlier?.(place, new Date(Date.UTC(2026, 7, 3, 8, 20)));
    expect(read.mock.calls[0][0].map((line) => [line.senderName, line.account])).toEqual([
      ["Rome", null],
      ["Ouou", null],
    ]);
  });

  it("keeps what was said earlier in the second of the session's first message", async () => {
    const at = (ms: number, id: string, text: string) => ({
      ...message(20, text),
      messageId: id,
      timestamp: new Date(Date.UTC(2026, 7, 3, 8, 20, 0, ms)),
    });
    // Newest first, as a platform answers: the question at .900 opens the
    // session, a fact came at .100, and a follow-up at .950.
    const page = [
      at(950, "q2", "and also"),
      at(900, "q1", "what is it?"),
      // Shares the question's millisecond: Slack's ts orders the two finer
      // than a Date can, and the page answers in that order.
      at(900, "g", "or 43"),
      at(100, "f", "it is 42"),
    ];
    const { promptFacts, latest } = earlierFacts(page, true, { 31: "q1" });
    // Rome's record holds the question at the whole second.
    const before = new Date(Date.UTC(2026, 7, 3, 8, 20));

    const earlier = await promptFacts.earlier?.(place, before, 31);

    expect(earlier?.map((m) => m.text)).toEqual(["it is 42", "or 43"]);
    expect(latest).toHaveBeenCalledWith(place, {
      limit: 16,
      until: new Date(before.getTime() + 999),
      olderThan: "q1",
    });
  });

  it("reads a thread again from the last message the model was shown there", async () => {
    // Newest first: the second mention (m9) and the first (m5), with replies
    // that did not mention Rome before and between them.
    const page = [message(9), message(8), message(7), message(5), message(3)];
    const { promptFacts } = earlierFacts(page, true, { 41: "m5", 42: "m9", 43: "m1" });
    const group = { channel: "slack_app", threadId: "C1", threadType: "group" as const };
    const before = new Date(Date.UTC(2026, 7, 3, 8, 30));

    const first = await promptFacts.thread?.(group, "C1:root", before, 42);
    const later = await promptFacts.thread?.(group, "C1:root", before, 42, 41);
    // More was said since than one page holds: the page is read whole.
    const behind = await promptFacts.thread?.(group, "C1:root", before, 42, 43);

    expect(first?.map((m) => m.text)).toEqual(["message 3", "message 5", "message 7", "message 8"]);
    expect(later?.map((m) => m.text)).toEqual(["message 7", "message 8"]);
    expect(behind?.map((m) => m.text)).toEqual(first?.map((m) => m.text));
  });

  it("asks for what was said up to the turn, so a backlog said since takes no room on the page", async () => {
    const { promptFacts, latest } = earlierFacts([message(1)]);
    const before = new Date(Date.UTC(2026, 7, 3, 8, 20));
    await promptFacts.earlier?.(place, before);
    expect(latest).toHaveBeenCalledWith(place, { limit: 16, until: before });
  });
});
