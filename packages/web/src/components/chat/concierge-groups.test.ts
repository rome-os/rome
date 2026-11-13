import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import type { ChatRow } from "./chat-view";
import type { SystemInputSource } from "@rome/api-types/trace-segments";
import {
  buildConciergeItems,
  type ConciergeItem,
  showsTyping,
  simulatedTypingMs,
} from "./concierge-groups";

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
    if (item.kind === "unread") return "new";
    const ids = item.entries.map((e) => e.message.id).join(",");
    return `${item.sender === "guardian" ? "G" : "A"}:${ids}${item.typing ? "+typing" : ""}`;
  });
}

const build = (rows: ChatRow[], typing = false) => buildConciergeItems(rows, { typing });

describe("buildConciergeItems", () => {
  it("shows a host quota notice immediately without a bubble and suppresses only the matching generic switch", () => {
    const message = {
      ...say("switch", 1_000, "host"),
      content: JSON.stringify([
        { type: "quota_switch", from: "anthropic", to: "openai", model: "gpt-6-luna" },
      ]),
    };
    const notice = {
      kind: "model_switch" as const,
      key: "generic",
      model: "gpt-6-luna",
      turnId: "recovered",
      sessionId: "concierge",
    };
    const initial = build([agentRow(message)]);
    expect(shape(initial)).toEqual(["notice"]);
    expect(initial[0]).toMatchObject({ quota: { from: "anthropic", to: "openai" } });
    expect(
      shape(
        build([
          agentRow(message),
          notice,
          agentRow(say("recovered", 2_000)),
          { ...notice, key: "manual", model: "claude-sonnet-5-5" },
        ]),
      ),
    ).toEqual(["notice", "sep", "A:recovered", "notice"]);
  });

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

describe("buildConciergeItems unread divider", () => {
  const withDivider = (rows: ChatRow[], unreadFrom: string | null | undefined) =>
    shape(buildConciergeItems(rows, { typing: false, unreadFrom }));

  it("draws no divider without an unread message", () => {
    const rows = [agentRow(say("a1", 0), say("a2", MIN))];
    expect(withDivider(rows, undefined)).toEqual(["sep", "A:a1,a2"]);
    expect(withDivider(rows, null)).toEqual(["sep", "A:a1,a2"]);
  });

  it("splits the group above the first unread message", () => {
    const rows = [agentRow(say("a1", 0), say("a2", MIN), say("a3", 2 * MIN))];
    expect(withDivider(rows, "a2")).toEqual(["sep", "A:a1", "new", "A:a2,a3"]);
  });

  it("goes after the time separator that introduces the first unread message", () => {
    const rows = [agentRow(say("a1", 0)), agentRow(say("a2", 20 * MIN))];
    expect(withDivider(rows, "a2")).toEqual(["sep", "A:a1", "sep", "new", "A:a2"]);
  });

  it("goes above the first message of the chat when everything is unread", () => {
    const rows = [agentRow(say("a1", 0), say("a2", MIN))];
    expect(withDivider(rows, "a1")).toEqual(["sep", "new", "A:a1,a2"]);
  });

  it("counts a guardian message sent from another device among the unread ones", () => {
    const rows = [
      agentRow(say("a1", 0)),
      userRow(guardian("g1", MIN)),
      agentRow(say("a2", 2 * MIN)),
    ];
    expect(withDivider(rows, "a1")).toEqual(["sep", "new", "A:a1", "G:g1", "A:a2"]);
  });

  it("draws no divider when the named message draws nothing", () => {
    const empty = {
      ...say("empty", MIN),
      content: JSON.stringify([{ type: "text", content: " " }]),
    };
    const rows = [agentRow(say("a1", 0), empty, say("a2", 2 * MIN))];
    expect(withDivider(rows, "empty")).toEqual(["sep", "A:a1,a2"]);
  });

  it("gives a message that arrives after a hidden unread tail no divider", () => {
    const empty = {
      ...say("empty", MIN),
      content: JSON.stringify([{ type: "text", content: " " }]),
    };
    const rows = [agentRow(say("a1", 0), empty)];
    expect(withDivider(rows, "empty")).toEqual(["sep", "A:a1"]);
    expect(withDivider([...rows, agentRow(say("a2", 2 * MIN))], "empty")).toEqual([
      "sep",
      "A:a1,a2",
    ]);
    expect(withDivider([...rows, userRow(guardian("g1", 2 * MIN))], "empty")).toEqual([
      "sep",
      "A:a1",
      "G:g1",
    ]);
  });

  it("draws no divider when the unread message is not in the rows", () => {
    expect(withDivider([agentRow(say("a1", 0))], "older")).toEqual(["sep", "A:a1"]);
  });

  it("draws one divider only", () => {
    const rows = [
      agentRow(say("a1", 0)),
      agentRow(say("a2", 20 * MIN)),
      agentRow(say("a3", 40 * MIN)),
    ];
    expect(withDivider(rows, "a2").filter((entry) => entry === "new")).toHaveLength(1);
  });

  it("hands back the same divider object on every build", () => {
    const rows = [agentRow(say("a1", 0), say("a2", MIN))];
    const find = () =>
      buildConciergeItems(rows, { typing: false, unreadFrom: "a2" }).find(
        (item) => item.kind === "unread",
      );
    expect(find()).toBeDefined();
    expect(find()).toBe(find());
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

describe("showsTyping", () => {
  // The owner's message the running turn took: it shows 👀, and the dots say a message is coming.
  const asked = [userRow({ ...guardian("g1", 0), turnId: "t1" } as ChatMessage)];
  const writing = (mode: "exact" | "simulated", on: boolean) => ({
    sessionId: "s",
    turnId: "t1",
    mode,
    writing: on,
  });
  const live = (extra: { quiet?: boolean; writing?: ReturnType<typeof writing> | null } = {}) => ({
    isStreaming: true,
    runningTurnId: "t1",
    ...extra,
  });

  it("types on an exact turn while the server says it writes a message", () => {
    expect(showsTyping(asked, live({ writing: writing("exact", true) }))).toBe(true);
    expect(showsTyping(asked, live({ writing: writing("exact", false) }))).toBe(false);
  });

  it("infers nothing: no word from the server, or a simulated turn, shows none of itself", () => {
    expect(showsTyping(asked, live())).toBe(false);
    expect(showsTyping(asked, live({ writing: writing("simulated", false) }))).toBe(false);
  });

  it("types while a simulated turn's message is held behind the dots", () => {
    expect(showsTyping(asked, live({ writing: writing("simulated", false) }), true)).toBe(true);
  });

  it("keeps a quiet turn silent until it says something", () => {
    expect(showsTyping(asked, live({ quiet: true, writing: writing("exact", true) }))).toBe(false);
    const said = [...asked, agentRow(say("a1", MIN))];
    expect(showsTyping(said, live({ quiet: true, writing: writing("exact", true) }))).toBe(true);
  });

  it("never types once the turn has ended", () => {
    expect(
      showsTyping(asked, { ...live({ writing: writing("exact", true) }), isStreaming: false }),
    ).toBe(false);
  });
});

describe("simulatedTypingMs", () => {
  const of = (length: number) =>
    simulatedTypingMs({
      ...say("a1", 0),
      content: JSON.stringify([{ type: "text", content: "x".repeat(length) }]),
    } as ChatMessage);

  it("waits by the message's length, half a second to one second", () => {
    expect(of(10)).toBe(500);
    expect(of(150)).toBe(750);
    expect(of(5000)).toBe(1000);
  });
});

describe("where a reply came from", () => {
  const routine = { type: "routine" as const, name: "Daily summary" };
  const inputRow = (turnId: string, source: SystemInputSource = routine): ChatRow => ({
    kind: "automated_input",
    key: `automated-input:${turnId}`,
    source,
    turnId,
  });
  const entries = (items: ConciergeItem[]) =>
    items.flatMap((item) => (item.kind === "group" ? item.entries : []));

  it("labels the replies of a turn an automated input started with its source, and draws no line for it", () => {
    const items = build([
      inputRow("t1"),
      agentRow(say("answer", MIN, "t1"), say("more", MIN + 1_000, "t1")),
    ]);
    expect(shape(items)).toEqual(["sep", "A:answer,more"]);
    expect(entries(items).map((entry) => entry.source)).toEqual([routine, routine]);
  });

  it("labels a reply only when someone else made the Concierge speak", () => {
    const sources = [
      routine,
      { type: "app" as const, name: "Inbox" },
      { type: "agent" as const, name: "Flint" },
      { type: "automation" as const, name: null },
      { type: "check" as const, name: "Flights" },
      { type: "following" as const, name: "news" },
      { type: "digest" as const, name: null },
    ];
    const items = build(
      sources.flatMap((source, index) => [
        inputRow(`t${index}`, source),
        agentRow(say(`reply ${index}`, MIN + index * 1_000, `t${index}`)),
      ]),
    );
    // The Concierge's own wake-ups, a check, what it follows and its digest, label nothing.
    expect(entries(items).map((entry) => entry.source?.type)).toEqual([
      "routine",
      "app",
      "agent",
      "automation",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("draws nothing for an automated input whose turn said nothing", () => {
    expect(build([inputRow("t1")])).toEqual([]);
  });

  it("leaves a reply to the owner unlabelled", () => {
    const asked = guardian("asked", 0);
    asked.turnId = "t2";
    const items = build([inputRow("t1"), userRow(asked), agentRow(say("answer", MIN, "t2"))]);
    expect(entries(items).map((entry) => entry.source)).toEqual([undefined, undefined]);
  });

  it("draws an on-behalf message from before as no owner bubble, and labels its turn's reply", () => {
    const old = guardian("on-behalf", 0);
    old.turnId = "t1";
    old.sender = {
      kind: "automated",
      sourceType: "agent",
      name: "Flint",
      iconUrl: null,
      onBehalfOf: { kind: "guardian", name: "Ray", avatarUrl: null },
    };
    const items = build([
      userRow(guardian("typed", -MIN)),
      userRow(old),
      agentRow(say("answer", MIN, "t1")),
    ]);
    expect(shape(items)).toEqual(["sep", "G:typed", "A:answer"]);
    expect(entries(items).at(-1)?.source).toEqual({ type: "agent", name: "Flint" });
  });

  it("draws an automated message from before as no bubble, and nothing when its turn said nothing", () => {
    const old = guardian("old-auto", 0);
    old.turnId = "t1";
    old.sender = { kind: "automated", sourceType: "agent", name: "Milo", iconUrl: null };
    expect(build([userRow(old)])).toEqual([]);
  });
});
