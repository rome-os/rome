import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import type { ChatRow } from "./chat-view";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { buildConciergeItems, type ConciergeItem, showsTyping } from "./concierge-groups";

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

it("groups an on-behalf Concierge message with adjacent guardian messages", () => {
  const automated = guardian("on-behalf", MIN);
  automated.sender = {
    kind: "automated",
    sourceType: "agent",
    name: "Concierge",
    iconUrl: null,
    onBehalfOf: { kind: "guardian", name: "Ray", avatarUrl: null },
  };
  const items = buildConciergeItems([userRow(guardian("typed", 0)), userRow(automated)], {
    typing: false,
  });
  const groups = items.filter((item) => item.kind === "group");
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    sender: "guardian",
    entries: [{ message: { id: "typed" } }, { message: { id: "on-behalf" } }],
  });
});

describe("showsTyping", () => {
  const block = (ordinal: number, b: Record<string, unknown>) => ({
    kind: "block" as const,
    id: `b${ordinal}`,
    block: b,
    ordinal,
  });
  const trace = (...blocks: Record<string, unknown>[]) =>
    ({
      segments: blocks.map((b, i) => block(i, b)),
      summary: { distinctApps: [], totalSteps: 0, invocationCounts: {} },
    }) as unknown as TraceSnapshot;
  const use = (id: string, tool: string) => ({ type: "tool_use", id, tool, input: {} });
  const result = (id: string, tool: string) => ({
    type: "tool_result",
    toolUseId: id,
    tool,
    output: "",
  });
  const asked = [userRow(guardian("g1", 0))];
  const live = (snapshot: TraceSnapshot | null, extra: { quiet?: boolean } = {}) => ({
    isStreaming: true,
    runningTurnId: "t1",
    snapshot,
    ...extra,
  });

  it("types from the turn's start until its first message", () => {
    expect(showsTyping(asked, live(null))).toBe(true);
    expect(showsTyping(asked, live(trace(use("s1", "core:say"))))).toBe(true);
  });

  it("stops once the turn has said something, while it only closes off", () => {
    const said = [...asked, agentRow(say("a1", MIN))];
    const afterSay = trace(use("s1", "core:say"), result("s1", "core:say"));
    expect(showsTyping(said, live(afterSay))).toBe(false);
    // A forward is a message too.
    expect(showsTyping(said, live(trace(use("f1", "mcp__rome__chat_forward"))))).toBe(false);
  });

  it("types again while the turn works on in another call, and stops at its next message", () => {
    const said = [...asked, agentRow(say("a1", MIN))];
    const working = trace(use("s1", "core:say"), result("s1", "core:say"), use("w1", "WebSearch"));
    expect(showsTyping(said, live(working))).toBe(true);
    const done = trace(
      use("s1", "core:say"),
      result("s1", "core:say"),
      use("w1", "WebSearch"),
      result("w1", "WebSearch"),
      use("s2", "core:say"),
      result("s2", "core:say"),
    );
    expect(showsTyping([...said, agentRow(say("a2", 2 * MIN))], live(done))).toBe(false);
  });

  it("keeps a quiet turn silent until it says something", () => {
    expect(showsTyping(asked, live(null, { quiet: true }))).toBe(false);
    const said = [...asked, agentRow(say("a1", MIN))];
    expect(showsTyping(said, live(trace(use("w1", "WebSearch")), { quiet: true }))).toBe(true);
  });

  it("never types in a turn that took the owner's message, which shows its own mark", () => {
    const taken = [userRow({ ...guardian("g2", MIN), turnId: "t1" } as ChatMessage)];
    expect(showsTyping(taken, live(null))).toBe(false);
    expect(showsTyping(taken, live(trace(use("w1", "WebSearch"))))).toBe(false);
  });

  it("never types once the turn has ended", () => {
    expect(showsTyping(asked, { ...live(null), isStreaming: false })).toBe(false);
  });
});
