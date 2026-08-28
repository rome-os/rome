import { describe, it, expect } from "@rstest/core";
import { latestDynamic, parseTimelineCursor, type TimelineEntry } from "@rome/api-types/people";
import { memoryMessages } from "../channels/messages-memory.js";
import type { MessageAccount, Messages } from "../channels/messages.js";
import { readPersonTimeline } from "./timeline.js";
import { readPeopleActivity } from "./activity.js";

// The merge above the stores: what a page is, how it resumes, and which store
// owns an account. Every store here is in-memory, so nothing below is about
// SQL — a store that answers the `Messages` contract is a store this merge can
// page.

const account = (channel: string, ...addresses: string[]): MessageAccount => ({
  channel,
  addresses,
});

const entry = (
  source: string,
  timestamp: number,
  ref: string,
  direction: "inbound" | "outbound" = "inbound",
): TimelineEntry => ({ source, timestamp, ref, direction, body: `${ref}@${timestamp}` });

/**
 * A store holding `held`, keyed by the address each entry arrived at — the
 * reference `Messages` implementation, which is what makes these fakes prove
 * something: they answer the contract every real adapter is enrolled in.
 *
 * An entry's `source` is the channel it belongs to, so an address on one
 * channel never answers for an account on another.
 */
function store(held: Record<string, TimelineEntry[]>): Messages {
  return memoryMessages(
    Object.entries(held).flatMap(([address, entries]) =>
      entries.map((held) => ({ channel: held.source, address, entry: held })),
    ),
  );
}

/** One store, with every verb the merge reaches for written down. The property
 *  name rather than only the call, so a merge that asked for a verb `Messages`
 *  does not have is caught here rather than by the type checker alone. */
function watched(
  name: string,
  messages: Messages,
  asked: Array<{ store: string; verb: string }>,
): Messages {
  return new Proxy(messages, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string") return value;
      asked.push({ store: name, verb: property });
      return value;
    },
  });
}

describe("readPersonTimeline", () => {
  const whatsapp = store({
    "wa-1": [entry("whatsapp", 300, "wa:c"), entry("whatsapp", 100, "wa:a")],
  });
  const telegram = store({
    "tg-1": [entry("telegram", 200, "tg:b"), entry("telegram", 400, "tg:d")],
  });
  const accounts = [account("whatsapp", "wa-1"), account("telegram", "tg-1")];

  it("merges every account of a person into one newest-first page", async () => {
    const page = await readPersonTimeline([whatsapp, telegram], accounts, { limit: 10 });
    expect(page.entries.map((e) => e.ref)).toEqual(["tg:d", "wa:c", "tg:b", "wa:a"]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages by nextCursor with no duplicate and no missing entry", async () => {
    const whole = (await readPersonTimeline([whatsapp, telegram], accounts, { limit: 10 })).entries;

    const walked: TimelineEntry[] = [];
    let cursor: TimelineEntry | null = null;
    for (let page = 0; page < 10; page += 1) {
      const next = await readPersonTimeline([whatsapp, telegram], accounts, { cursor, limit: 1 });
      walked.push(...next.entries);
      if (next.nextCursor === null) break;
      cursor = parseTimelineCursor(next.nextCursor);
      expect(cursor).not.toBeNull();
    }
    expect(walked).toEqual(whole);
  });

  it("resumes inside a second rather than after it", async () => {
    // Four entries share one timestamp, so a cursor carrying the timestamp
    // alone could only resume before or after all of them.
    const crowded = store({
      "c-1": [
        entry("whatsapp", 100, "a"),
        entry("whatsapp", 100, "b", "outbound"),
        entry("whatsapp", 100, "c"),
        entry("whatsapp", 100, "d"),
      ],
    });
    const one = [account("whatsapp", "c-1")];
    const first = await readPersonTimeline([crowded], one, { limit: 2 });
    const rest = await readPersonTimeline([crowded], one, {
      cursor: parseTimelineCursor(first.nextCursor),
      limit: 10,
    });
    expect([...first.entries, ...rest.entries].map((e) => e.ref)).toEqual(["b", "a", "c", "d"]);
    expect(rest.nextCursor).toBeNull();
  });

  it("reports a next page whenever one exists", async () => {
    // The page is full and the history is exhausted at the same entry: a
    // caller told there is more reads one empty page, a caller told there is
    // not loses everything after it.
    const exact = await readPersonTimeline([whatsapp, telegram], accounts, { limit: 4 });
    expect(exact.entries).toHaveLength(4);
    expect(exact.nextCursor).toBeNull();

    const short = await readPersonTimeline([whatsapp, telegram], accounts, { limit: 3 });
    expect(short.nextCursor).not.toBeNull();
  });

  it("gives an account to the first store whose latest answers, and asks no other", async () => {
    // Ownership is derived rather than asked for: the mirror answers a newest
    // message for the account, so the transcript's copy of the same exchange is
    // never read — and the transcript is not asked anything at all.
    const asked: Array<{ store: string; verb: string }> = [];
    const mirror = watched(
      "mirror",
      store({ "wa-1": [entry("whatsapp", 500, "mirrored")] }),
      asked,
    );
    const transcript = watched(
      "transcript",
      store({ "wa-1": [entry("whatsapp", 500, "transcribed")] }),
      asked,
    );
    const page = await readPersonTimeline([mirror, transcript], [account("whatsapp", "wa-1")], {
      limit: 10,
    });
    expect(page.entries.map((e) => e.ref)).toEqual(["mirrored"]);
    expect(new Set(asked.map((call) => call.store))).toEqual(new Set(["mirror"]));
  });

  it("falls through to a later store for an account the earlier one holds nothing for", async () => {
    const mirror = store({ "wa-1": [entry("whatsapp", 500, "mirrored")] });
    const transcript = store({ "tg-1": [entry("telegram", 400, "typed")] });
    const page = await readPersonTimeline([mirror, transcript], accounts, { limit: 10 });
    expect(page.entries.map((e) => e.ref)).toEqual(["mirrored", "typed"]);
  });

  it("takes a new store as one more adapter, with nothing above it changed", async () => {
    // What "adding a store is one adapter" means: a store of a kind this file
    // has never heard of, appended to the list, and its entries page with the
    // rest through the same cursor.
    const app = store({ "app-1": [entry("bookings", 250, "booking:7", "outbound")] });
    const page = await readPersonTimeline(
      [whatsapp, telegram, app],
      [...accounts, account("bookings", "app-1")],
      { limit: 10 },
    );
    expect(page.entries.map((e) => e.ref)).toEqual(["tg:d", "wa:c", "booking:7", "tg:b", "wa:a"]);
  });

  it("answers an empty page for a person with no accounts", async () => {
    const page = await readPersonTimeline([whatsapp, telegram], [], { limit: 10 });
    expect(page).toEqual({ entries: [], nextCursor: null });
  });

  it("asks a store for nothing but read, count and latest", async () => {
    // The seam is `Messages` and only `Messages`: `holds` and `digest` were how
    // the old interface asked a store who it answered for, and a merge still
    // reaching for either would be reading a store two ways at once.
    const asked: Array<{ store: string; verb: string }> = [];
    const only = watched("only", store({ "wa-1": [entry("whatsapp", 500, "mirrored")] }), asked);
    await readPersonTimeline([only], [account("whatsapp", "wa-1")], { limit: 10 });

    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked.map((call) => call.verb))).toEqual(new Set(["read", "latest"]));
  });
});

// The same precedence, read as a summary instead of a page: what a directory
// row shows for a person without opening their dossier.
describe("readPeopleActivity", () => {
  const waAccount = account("whatsapp", "wa-1");
  const tgAccount = account("telegram", "tg-1");

  it("summarizes each account from the first store that claims it", async () => {
    // One exchange written down twice, as the real stores overlap. Counting
    // both would report an inbox the dossier does not have.
    const mirror = store({ "wa-1": [entry("whatsapp", 500, "mirrored")] });
    const transcript = store({
      "wa-1": [entry("whatsapp", 500, "copy"), entry("whatsapp", 200, "older copy")],
      "tg-1": [entry("telegram", 400, "typed")],
    });

    const [whatsapp, telegram] = await readPeopleActivity(
      [mirror, transcript],
      [[waAccount], [tgAccount]],
    );
    expect(whatsapp).toEqual({
      messageCount: 1,
      latest: { source: "whatsapp", timestamp: 500, preview: "mirrored@500" },
    });
    expect(telegram?.messageCount).toBe(1);
  });

  it("folds a person's accounts into one history", async () => {
    const held = store({
      "wa-1": [entry("whatsapp", 300, "wa:c"), entry("whatsapp", 100, "wa:a")],
      "tg-1": [entry("telegram", 400, "tg:d")],
    });

    const [both] = await readPeopleActivity([held], [[waAccount, tgAccount]]);
    expect(both).toEqual({
      messageCount: 3,
      // The head of the merged timeline, not of whichever account came first.
      latest: { source: "telegram", timestamp: 400, preview: "tg:d@400" },
    });
  });

  it("answers one activity per group, in the order given", async () => {
    const held = store({ "tg-1": [entry("telegram", 400, "tg:d")] });
    expect(await readPeopleActivity([held], [[waAccount], [], [tgAccount]])).toEqual([
      { latest: null, messageCount: 0 },
      { latest: null, messageCount: 0 },
      { latest: { source: "telegram", timestamp: 400, preview: "tg:d@400" }, messageCount: 1 },
    ]);
  });

  it("previews the entry the person's own timeline opens on, and counts its length", async () => {
    // The listing and the page are one read of one set of stores, so the row a
    // guardian clicks and the history it opens cannot disagree — the preview is
    // the first entry of the timeline, and the number beside it the length of
    // exactly that timeline.
    const mirror = store({
      "wa-1": [entry("whatsapp", 500, "mirrored"), entry("whatsapp", 300, "earlier")],
    });
    const transcript = store({
      // The same WhatsApp exchange again, and a newer entry on a channel with
      // no mirror: counting the copy would put a number on the row the page
      // never reaches.
      "wa-1": [entry("whatsapp", 500, "copy")],
      "tg-1": [entry("telegram", 700, "tg:newest"), entry("telegram", 200, "tg:old")],
    });
    const stores = [mirror, transcript];
    const accounts = [waAccount, tgAccount];

    const [activity] = await readPeopleActivity(stores, [accounts]);
    const timeline = await readPersonTimeline(stores, accounts, { limit: 100 });

    expect(timeline.entries.map((e) => e.ref)).toEqual([
      "tg:newest",
      "mirrored",
      "earlier",
      "tg:old",
    ]);
    expect(activity?.latest).toEqual(latestDynamic(timeline.entries));
    expect(activity?.messageCount).toBe(timeline.entries.length);
  });

  it("asks a store for nothing but read, count and latest", async () => {
    const asked: Array<{ store: string; verb: string }> = [];
    const only = watched("only", store({ "wa-1": [entry("whatsapp", 500, "mirrored")] }), asked);
    await readPeopleActivity([only], [[waAccount]]);

    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked.map((call) => call.verb))).toEqual(new Set(["count", "latest"]));
  });
});
