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
    const group = { channel: "slack_app", threadId: "C1", threadType: "group" as const };
    const before = new Date(Date.UTC(2026, 7, 3, 8, 30));
    // The thread from its start, as a platform reads one: the first mention
    // (m5) and replies that did not mention Rome before it.
    const fromStart = earlierFacts([message(5), message(3)], true, { 42: "m5" });
    // From the first mention on: replies that did not mention Rome, then
    // the second mention (m9), newest first.
    const since = earlierFacts([message(9), message(8), message(7)], true, {
      41: "m5",
      42: "m9",
    });

    const first = await fromStart.promptFacts.thread?.(group, "C1:root", before, 42);
    const later = await since.promptFacts.thread?.(group, "C1:root", before, 42, 41);

    expect(first?.messages.map((m) => m.text)).toEqual(["message 3"]);
    expect(later?.messages.map((m) => m.text)).toEqual(["message 7", "message 8"]);
    expect(later?.cut).toBe(false);
    // Asked from the message shown last, which the platform answers after:
    // a thread longer than a page still reads what came since.
    expect(since.latest).toHaveBeenCalledWith(
      { ...group, threadId: "C1:root" },
      { limit: 16, until: new Date(before.getTime() + 999), newerThan: "m5" },
    );
  });

  it("says a later thread read stops short when its page does not reach the turn's message, however short the page", async () => {
    const group = { channel: "slack_app", threadId: "C1", threadType: "group" as const };
    const before = new Date(Date.UTC(2026, 7, 3, 8, 30));
    // Fourteen replies since the mention shown last (m5), newest first: the
    // connection left out the thread's root, which Slack puts on every page,
    // and more replies come before the turn's mention (m29).
    const page = Array.from({ length: 14 }, (_, i) => message(19 - i));
    const since = earlierFacts(page, true, { 41: "m5", 42: "m29" });

    const later = await since.promptFacts.thread?.(group, "C1:root", before, 42, 41);

    expect(later?.messages).toHaveLength(14);
    expect(later?.cut).toBe(true);
  });

  it("asks for what was said up to the turn, so a backlog said since takes no room on the page", async () => {
    const { promptFacts, latest } = earlierFacts([message(1)]);
    const before = new Date(Date.UTC(2026, 7, 3, 8, 20));
    await promptFacts.earlier?.(place, before);
    expect(latest).toHaveBeenCalledWith(place, { limit: 16, until: before });
  });
});

describe("chatPromptFacts on an account that serves its workspace", () => {
  const message = (minute: number, text = `message ${minute}`) => ({
    channel: "slack_app",
    chatId: "C1",
    messageId: `m${minute}`,
    direction: "inbound",
    senderId: "T_A/U_SAM",
    senderDisplayName: "Sam",
    text,
    attachments: [],
    timestamp: new Date(Date.UTC(2026, 7, 3, 8, minute)),
    account: { platform: "slack", id: "T_A/U_ROME" },
  });
  const workspaceFacts = (
    latest: (place: never, bounds: never) => Promise<unknown[]>,
    keys: Record<number, string> = {},
    serves = true,
  ) => {
    const read = rs.fn(latest);
    const promptFacts = chatPromptFacts({
      facts: { unseen: () => [], seen: () => undefined },
      messages: {
        byIds: (ids) => ids.flatMap((id) => (keys[id] ? [{ key: keys[id] } as never] : [])),
      },
      labels: {
        read: (async (lines: readonly { senderName: string | null }[]) =>
          lines.map((line) => ({ ...line, sender: line.senderName, who: null }))) as never,
        readUnseen: async () => [],
      },
      channelOfChat: () => null,
      channelSurface: () => ({ interactiveCards: false, promptContext: true }),
      latest: read as never,
      servesWorkspace: (connectionId) => serves && connectionId === "slack",
      connectionOfChannel: (channel) => (channel === "slack_app" ? "slack" : null),
      chatWaitMs: 50,
    });
    return { promptFacts, read };
  };
  const group = {
    channel: "slack_app",
    threadId: "C1",
    threadType: "group" as const,
    connectionId: "slack",
    threadName: "general",
  };
  const before = new Date(Date.UTC(2026, 7, 3, 8, 30));

  it("shows a new session the chat's latest messages before the mention", async () => {
    // Newest first: the mention (m20) and two messages that did not mention Rome.
    const { promptFacts } = workspaceFacts(
      async () => [message(20), message(12, "the code is 7"), message(10)],
      { 42: "m20" },
    );
    const said = await promptFacts.chat?.(group, before, 42);
    expect(said?.map((m) => m.text)).toEqual(["message 10", "the code is 7"]);
  });

  it("reads only what was said since the last message the model was shown", async () => {
    const { promptFacts, read } = workspaceFacts(async () => [message(20), message(15)], {
      41: "m9",
      42: "m20",
    });
    const said = await promptFacts.chat?.(group, before, 42, 41);
    expect(said?.map((m) => m.text)).toEqual(["message 15"]);
    expect(read).toHaveBeenCalledWith(group, {
      limit: 16,
      until: new Date(before.getTime() + 999),
      newerThan: "m9",
    });
  });

  it("shows the latest messages when the read since the last one shown is refused", async () => {
    // More was said since than one page holds: the platform refuses to read
    // forward, and the turn is shown the latest messages, as a new session.
    const { promptFacts, read } = workspaceFacts(
      async (_place: unknown, bounds: { newerThan?: string }) => {
        if (bounds?.newerThan) throw new Error("More than 15 messages follow m9 in Slack chat C1");
        return [message(20), message(19, "the launch moved to Friday")];
      },
      { 41: "m9", 42: "m20" },
    );
    const said = await promptFacts.chat?.(group, before, 42, 41);
    expect(said?.map((m) => m.text)).toEqual(["the launch moved to Friday"]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(group, {
      limit: 16,
      until: new Date(before.getTime() + 999),
    });
  });

  it("reads no fallback when the read since the last one shown is only late", async () => {
    const { promptFacts, read } = workspaceFacts(() => new Promise(() => {}), { 41: "m9" });
    expect(await promptFacts.chat?.(group, before, undefined, 41)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers none when the platform refuses the read or takes too long", async () => {
    const refused = workspaceFacts(async () => {
      throw new Error("Slack lets Rome read this workspace's history about once a minute");
    });
    expect(await refused.promptFacts.chat?.(group, before)).toBeNull();
    const slow = workspaceFacts(() => new Promise(() => {}));
    expect(await slow.promptFacts.chat?.(group, before)).toBeNull();
  });

  it("reads no chat of any other account on each turn", async () => {
    const { promptFacts, read } = workspaceFacts(async () => [message(1)], {}, false);
    expect(await promptFacts.chat?.(group, before)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("names the chat and thread a turn's message was said in", () => {
    const { promptFacts } = workspaceFacts(async () => []);
    expect(promptFacts.place?.(group, "C1:1700.1")).toBe(
      "<place>\nchat: C1\nthread: C1:1700.1\nkind: group\nname: general\n</place>",
    );
    // A task's report names its chat by channel alone, and does not know
    // what kind of chat it is.
    expect(promptFacts.place?.({ channel: "slack_app", threadId: "D2" }, undefined)).toBe(
      "<place>\nchat: D2\nthread: none\n</place>",
    );
    expect(promptFacts.place?.({ ...group, connectionId: "telegram" }, undefined)).toBeNull();
  });
});
