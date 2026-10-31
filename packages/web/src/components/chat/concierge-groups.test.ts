import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import type { ChatRow } from "./chat-view";
import { buildConciergeItems, conciergeTurnVisible, type ConciergeItem } from "./concierge-groups";

const MIN = 60_000;
// Local noon, so a few hours either way stays on the same local day.
const NOON = new Date(2026, 9, 27, 12, 0, 0).getTime();

const at = (offsetMs: number) => new Date(NOON + offsetMs).toISOString();

function say(id: string, offsetMs: number, turnId = "t1", text = id): ChatMessage {
  return {
    id,
    sessionId: "concierge",
    turnId,
    role: "assistant",
    content: JSON.stringify([{ type: "text", content: text }]),
    createdAt: at(offsetMs),
  } as ChatMessage;
}

function guardian(id: string, offsetMs: number, text = id): ChatMessage {
  return {
    id,
    sessionId: "concierge",
    role: "user",
    content: JSON.stringify([{ type: "text", content: text }]),
    createdAt: at(offsetMs),
  } as ChatMessage;
}

const userRow = (message: ChatMessage): ChatRow => ({ kind: "user", key: message.id, message });
const agentRow = (...messages: ChatMessage[]): ChatRow =>
  ({
    kind: "agent",
    key: messages[0].id,
    identity: { name: "Rome", iconUrl: null },
    trace: null,
    messages,
  }) as ChatRow;

/** Compact shape: `sep`, `notice`, or `G:a,b` / `A:a,b` for a guardian / agent group. */
function shape(items: ConciergeItem[]): string[] {
  return items.map((item) => {
    if (item.kind === "separator") return "sep";
    if (item.kind === "notice") return "notice";
    const ids = item.entries.map((e) => e.message.id).join(",");
    return `${item.sender === "guardian" ? "G" : "A"}:${ids}${item.typing ? "+typing" : ""}`;
  });
}

const build = (rows: ChatRow[], typing = false) => buildConciergeItems(rows, { typing });

describe("buildConciergeItems", () => {
  it("opens with a separator before the first message", () => {
    expect(shape(build([userRow(guardian("u1", 0))]))).toEqual(["sep", "G:u1"]);
  });

  it("returns nothing for an empty transcript", () => {
    expect(build([])).toEqual([]);
  });

  it("groups consecutive guardian messages", () => {
    const rows = [userRow(guardian("u1", 0)), userRow(guardian("u2", 30_000))];
    expect(shape(build(rows))).toEqual(["sep", "G:u1,u2"]);
  });

  it("groups the bubbles of one agent turn", () => {
    const rows = [agentRow(say("a1", 0), say("a2", 4_000), say("a3", 9_000))];
    expect(shape(build(rows))).toEqual(["sep", "A:a1,a2,a3"]);
  });

  it("starts a new group when the sender changes", () => {
    const rows = [
      userRow(guardian("u1", 0)),
      agentRow(say("a1", 5_000)),
      userRow(guardian("u2", 20_000)),
    ];
    expect(shape(build(rows))).toEqual(["sep", "G:u1", "A:a1", "G:u2"]);
  });

  it("joins agent messages of separate turns that are close in time", () => {
    const rows = [agentRow(say("a1", 0, "t1")), agentRow(say("a2", 2 * MIN, "t2"))];
    expect(shape(build(rows))).toEqual(["sep", "A:a1,a2"]);
  });

  it("keeps a gap just under five minutes in the group and splits at five", () => {
    const under = [userRow(guardian("u1", 0)), userRow(guardian("u2", 5 * MIN - 1))];
    expect(shape(build(under))).toEqual(["sep", "G:u1,u2"]);
    const exact = [userRow(guardian("u1", 0)), userRow(guardian("u2", 5 * MIN))];
    expect(shape(build(exact))).toEqual(["sep", "G:u1", "G:u2"]);
  });

  it("splits a group without a separator for a gap between five and fifteen minutes", () => {
    const rows = [userRow(guardian("u1", 0)), userRow(guardian("u2", 10 * MIN))];
    expect(shape(build(rows))).toEqual(["sep", "G:u1", "G:u2"]);
  });

  it("adds a separator at fifteen minutes and not before", () => {
    const under = [userRow(guardian("u1", 0)), userRow(guardian("u2", 15 * MIN - 1))];
    expect(shape(build(under))).toEqual(["sep", "G:u1", "G:u2"]);
    const exact = [userRow(guardian("u1", 0)), userRow(guardian("u2", 15 * MIN))];
    expect(shape(build(exact))).toEqual(["sep", "G:u1", "sep", "G:u2"]);
  });

  it("measures the gap between adjacent messages, not from the group start", () => {
    const rows = [
      userRow(guardian("u1", 0)),
      userRow(guardian("u2", 4 * MIN)),
      userRow(guardian("u3", 8 * MIN)),
    ];
    expect(shape(build(rows))).toEqual(["sep", "G:u1,u2,u3"]);
  });

  it("adds a separator and splits the group when the local day changes", () => {
    const lateNight = new Date(2026, 9, 27, 23, 58, 0).getTime();
    const early = (id: string, ms: number) => ({
      ...guardian(id, 0),
      createdAt: new Date(ms).toISOString(),
    });
    const rows = [
      userRow(early("u1", lateNight)),
      // Two minutes later but past midnight.
      userRow(early("u2", lateNight + 2 * MIN)),
    ];
    expect(shape(build(rows))).toEqual(["sep", "G:u1", "sep", "G:u2"]);
  });

  it("does not let a model-switch notice join two groups", () => {
    const rows: ChatRow[] = [
      agentRow(say("a1", 0)),
      { kind: "model_switch", key: "ms", model: "m", turnId: "t2", sessionId: "concierge" },
      agentRow(say("a2", 10_000, "t2")),
    ];
    expect(shape(build(rows))).toEqual(["sep", "A:a1", "notice", "A:a2"]);
  });

  it("skips trace rows, blank text, and guardian messages with no text", () => {
    const rows: ChatRow[] = [
      {
        kind: "trace",
        key: "tr",
        message: say("tr", 0),
        identity: { name: "Rome", iconUrl: null },
      },
      userRow(guardian("u0", 0, "")),
      agentRow(say("blank", 1_000, "t1", "   ")),
      agentRow(say("a1", 2_000)),
    ];
    expect(shape(build(rows))).toEqual(["sep", "A:a1"]);
  });

  it("keeps a card-only message in the group", () => {
    const card = {
      ...say("card", 3_000),
      content: JSON.stringify([{ type: "task_chat", chatId: "c1", title: "Task" }]),
    } as ChatMessage;
    expect(shape(build([agentRow(say("a1", 0), card)]))).toEqual(["sep", "A:a1,card"]);
  });

  it("marks the last text-bearing message of each turn", () => {
    const card = {
      ...say("card", 6_000),
      content: JSON.stringify([{ type: "task_chat", chatId: "c1", title: "Task" }]),
    } as ChatMessage;
    const items = build([
      agentRow(say("a1", 0, "t1"), say("a2", 3_000, "t1"), card),
      agentRow(say("b1", 20_000, "t2")),
    ]);
    const marks = items.flatMap((item) =>
      item.kind === "group" ? item.entries.map((e) => `${e.message.id}:${e.endsTurn}`) : [],
    );
    expect(marks).toEqual(["a1:false", "a2:true", "card:false", "b1:true"]);
  });

  it("marks one end per turn when the turn spans two rows", () => {
    const items = build([
      agentRow(say("a1", 0, "t1")),
      userRow(guardian("u1", 10_000)),
      agentRow(say("a2", 20_000, "t1")),
    ]);
    const ends = items.flatMap((item) =>
      item.kind === "group" ? item.entries.filter((e) => e.endsTurn).map((e) => e.message.id) : [],
    );
    expect(ends).toEqual(["a2"]);
  });

  it("never marks a guardian message as a turn end", () => {
    const items = build([userRow({ ...guardian("u1", 0), turnId: "t1" } as ChatMessage)]);
    const group = items.find((i) => i.kind === "group");
    expect(group?.kind === "group" && group.entries[0].endsTurn).toBe(false);
  });

  it("puts the typing bubble at the end of a trailing agent group", () => {
    expect(shape(build([agentRow(say("a1", 0))], true))).toEqual(["sep", "A:a1+typing"]);
  });

  it("gives the typing bubble its own group after a guardian message", () => {
    expect(shape(build([userRow(guardian("u1", 0))], true))).toEqual(["sep", "G:u1", "A:+typing"]);
  });

  it("returns a lone typing group for an empty transcript", () => {
    expect(shape(build([], true))).toEqual(["A:+typing"]);
  });

  it("groups by sender alone when a timestamp is unparsable", () => {
    const broken = { ...guardian("u2", 0), createdAt: "not a date" } as ChatMessage;
    const rows = [userRow(guardian("u1", 0)), userRow(broken)];
    expect(shape(build(rows))).toEqual(["sep", "G:u1,u2"]);
  });
});

describe("buildConciergeItems reference stability", () => {
  const history = [
    guardian("u1", 0),
    say("a1", 10_000, "t1"),
    // A quarter of an hour on: a new separator and a new group.
    guardian("u2", 20 * MIN),
    say("a2", 20 * MIN + 10_000, "t2"),
  ];
  const rowsOf = (messages: ChatMessage[]): ChatRow[] =>
    messages.map((message) => (message.role === "user" ? userRow(message) : agentRow(message)));

  it("hands back the same items and entries when nothing changed, whatever the rows are", () => {
    const first = build(rowsOf(history));
    // New row objects around the same messages, as a rebuilt transcript has.
    const second = build(rowsOf(history));

    expect(second).toHaveLength(first.length);
    second.forEach((item, index) => expect(item).toBe(first[index]));
  });

  it("renews only what a new message touches", () => {
    const before = build(rowsOf(history));
    const after = build(rowsOf([...history, say("a3", 20 * MIN + 20_000, "t3")]));

    // The first stretch and the separators are the same objects.
    expect(shape(after)).toEqual(["sep", "G:u1", "A:a1", "sep", "G:u2", "A:a2,a3"]);
    for (const index of [0, 1, 2, 3, 4]) expect(after[index]).toBe(before[index]);
    // The group a message joined is new, and still carries the entry it had.
    expect(after[5]).not.toBe(before[5]);
    expect((after[5] as { entries: unknown[] }).entries[0]).toBe(
      (before[5] as { entries: unknown[] }).entries[0],
    );
  });

  it("renews a group when the typing bubble comes and goes, and only that group", () => {
    const rows = rowsOf(history);
    const idle = build(rows);
    const typing = build(rows, true);

    expect(shape(typing).at(-1)).toBe("A:a2+typing");
    expect(typing.slice(0, -1)).toEqual(idle.slice(0, -1));
    typing.slice(0, -1).forEach((item, index) => expect(item).toBe(idle[index]));
    expect(typing.at(-1)).not.toBe(idle.at(-1));
  });

  it("renews the entry that stops ending its turn when a later bubble of the turn arrives", () => {
    const first = say("a1", 0, "t1");
    const before = build([agentRow(first)]);
    const after = build([agentRow(first, say("a2", 4_000, "t1"))]);

    const entryOf = (items: ConciergeItem[], index: number) =>
      (items[1] as Extract<ConciergeItem, { kind: "group" }>).entries[index];
    expect(entryOf(before, 0).endsTurn).toBe(true);
    expect(entryOf(after, 0)).not.toBe(entryOf(before, 0));
    expect(entryOf(after, 0).endsTurn).toBe(false);
    expect(entryOf(after, 1).endsTurn).toBe(true);
  });

  it("renews an item whose message was replaced by an edited copy", () => {
    const before = build(rowsOf(history));
    const edited = { ...history[1], content: JSON.stringify([{ type: "text", content: "new" }]) };
    const after = build(rowsOf([history[0], edited, ...history.slice(2)]));

    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(after[3]).toBe(before[3]);
  });
});

describe("conciergeTurnVisible", () => {
  const spoke = [agentRow(say("a1", 0, "t1"))];

  it("is false while nothing runs", () => {
    expect(conciergeTurnVisible(spoke, { isStreaming: false, runningTurnId: "t1" })).toBe(false);
  });

  it("is true for a running turn that is not quiet", () => {
    expect(conciergeTurnVisible([], { isStreaming: true, runningTurnId: "t1" })).toBe(true);
  });

  it("holds a quiet turn back until it has said something in that turn", () => {
    const live = { isStreaming: true, quiet: true, runningTurnId: "t1" };
    expect(conciergeTurnVisible([], live)).toBe(false);
    expect(conciergeTurnVisible([agentRow(say("a0", 0, "older"))], live)).toBe(false);
    expect(conciergeTurnVisible(spoke, live)).toBe(true);
  });
});
