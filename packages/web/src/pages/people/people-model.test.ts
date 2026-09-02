import { describe, expect, it } from "@rstest/core";
import type {
  AccountCounts,
  DirectoryAccount,
  PersonResource,
  StreamAccount,
} from "@rome/api-types/people";
import {
  directoryGroups,
  levelCounts,
  parsePeopleFilter,
  peoplePath,
  peopleRows,
  rowHandle,
  streamRows,
  type PeopleRow,
} from "./people-model";

// The People page reads two nouns — a person and the accounts they are reachable
// at — and renders one ladder over both. What is pinned here is the join: which
// contract row becomes which ladder position, how the two interleave in the
// stream, how the contacts list orders, and whose numbers the chips and headings
// show.
//
// Two account shapes, because there are two account reads. `contact` is the
// directory's row — everyone, and nothing about what was said. `spoke` is the
// stream's — an account something has happened on, with the line to preview.

const now = Math.floor(Date.now() / 1000);

function person(over: Partial<PersonResource> = {}): PersonResource {
  return {
    id: over.id ?? "ray-oster",
    displayName: "Ray Oster",
    bondLevel: "inner-circle",
    accounts: [{ channel: "telegram", channelUserId: "418820113", displayName: "Ray" }],
    messageCount: 2,
    latest: { source: "telegram", timestamp: now - 600, preview: "see you thursday" },
    ...over,
  };
}

/** One row of the contacts list. */
function contact(over: Partial<DirectoryAccount> = {}): DirectoryAccount {
  const channelUserId = over.channelUserId ?? "883104221";
  return {
    channel: "telegram",
    channelUserId,
    addresses: [channelUserId],
    displayName: "Jules Marchetti",
    state: "unlinked",
    personId: null,
    personName: null,
    ...over,
  };
}

/** The same account on the stream, with the dynamic that put it there. */
function spoke(over: Partial<StreamAccount> = {}): StreamAccount {
  return {
    ...contact(over),
    latest: { source: "telegram", timestamp: now - 300, preview: "is this the right number?" },
    messageCount: 1,
    ...over,
  };
}

const rowsOf = (rows: PeopleRow[]) => rows.map((row) => row.displayName);

describe("peopleRows", () => {
  it("places a person by their stored bond level, off-ladder values included", () => {
    const rows = peopleRows([person({ bondLevel: "colleague" })], []);
    // The column is free text and older rows carry values like "colleague".
    // Dropping one would take a person the guardian can see off every chip.
    expect(rows[0].level).toBe("other");
    expect(rows[0].kind).toBe("person");
  });

  it("reads an account's ladder position off the decision the guardian made", () => {
    const rows = peopleRows(
      [],
      [
        contact({ channelUserId: "1", state: "unlinked" }),
        contact({ channelUserId: "2", state: "dismissed" }),
      ],
    );
    expect(rows.map((row) => row.level)).toEqual(["unknown", "stranger"]);
  });

  it("leaves a linked account to the person it resolves to", () => {
    // The account and the person are the same human seen from two sides. Two
    // rows is the duplication the one-row-per-account rule exists to remove —
    // and the person is the row that can carry a bond.
    const rows = peopleRows(
      [person()],
      [
        contact({
          channel: "telegram",
          channelUserId: "418820113",
          state: "linked",
          personId: "ray-oster",
          personName: "Ray Oster",
        }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("person");
  });

  it("carries every address the server folded onto one account", () => {
    // The `@lid` consolidation is the contract's `addresses`: the server decides
    // which addresses are one account, and the client renders what it decided.
    const rows = peopleRows(
      [],
      [
        contact({
          channelUserId: "1555@s.whatsapp.net",
          addresses: ["1555", "1555@s.whatsapp.net"],
        }),
      ],
    );
    expect(rows[0].addresses).toEqual(["1555", "1555@s.whatsapp.net"]);
  });
});

describe("streamRows", () => {
  it("interleaves people and accounts by what happened last", () => {
    const rows = peopleRows(
      [person({ latest: { source: "telegram", timestamp: now - 900, preview: "older" } })],
      [
        spoke({
          channelUserId: "new",
          displayName: "Devika",
          latest: { source: "whatsapp", timestamp: now - 60, preview: "newer" },
        }),
      ],
    );
    // One stream over both nouns rather than a section each: a search spans the
    // whole ladder, and the two orders have to be one order for that to mean
    // anything.
    expect(rowsOf(streamRows(rows, { search: "dev", filter: "all" }))).toEqual(["Devika"]);
    expect(rowsOf(streamRows(rows, { search: "a", filter: "all" }))).toEqual([
      "Devika",
      "Ray Oster",
    ]);
  });

  it("holds both unplaced ends out of All, and lets each chip in", () => {
    const rows = peopleRows(
      [person()],
      [
        spoke({ channelUserId: "waiting", displayName: "Jules" }),
        spoke({ channelUserId: "spam", displayName: "Prize", state: "dismissed" }),
      ],
    );
    expect(rowsOf(streamRows(rows, { search: "", filter: "all" }))).toEqual(["Ray Oster"]);
    expect(rowsOf(streamRows(rows, { search: "", filter: "unknown" }))).toEqual(["Jules"]);
    expect(rowsOf(streamRows(rows, { search: "", filter: "stranger" }))).toEqual(["Prize"]);
  });

  it("holds back the guardian and anyone who has done nothing", () => {
    const rows = peopleRows(
      [
        person({ id: "me", displayName: "Mock Guardian", bondLevel: "guardian" }),
        person({ id: "quiet", displayName: "Nadia", latest: null, messageCount: 0 }),
      ],
      [],
    );
    // A stream row is something that happened, and it is about somebody else.
    // The read holds back the accounts nothing happened on; a person the
    // guardian entered by hand is on the people listing either way, so this end
    // of the rule is the client's.
    expect(rowsOf(streamRows(rows, { search: "", filter: "all" }))).toEqual([]);
  });

  it("lets a search reach the quiet ones, whatever chip is lit — guardian excepted", () => {
    const rows = peopleRows(
      [
        person({ id: "me", displayName: "Mock Guardian", bondLevel: "guardian" }),
        person({ id: "quiet", displayName: "Nadia Petrova", latest: null, accounts: [] }),
      ],
      [],
    );
    // Someone typing a name wants that person wherever they sit on the ladder.
    expect(rowsOf(streamRows(rows, { search: "nadia", filter: "inner-circle" }))).toEqual([
      "Nadia Petrova",
    ]);
    expect(rowsOf(streamRows(rows, { search: "mock", filter: "all" }))).toEqual([]);
  });
});

describe("directoryGroups", () => {
  const roster = () =>
    peopleRows(
      [
        person({ id: "me", displayName: "Mock Guardian", bondLevel: "guardian" }),
        person({ id: "ray", displayName: "Ray Oster", bondLevel: "inner-circle" }),
        person({ id: "sam", displayName: "Sam Okafor", bondLevel: "colleague" }),
      ],
      [
        contact({ channelUserId: "waiting", displayName: "Jules" }),
        contact({ channelUserId: "spam", displayName: "Prize", state: "dismissed" }),
        contact({ channelUserId: "quiet", displayName: "Jonas Tan" }),
        contact({ channelUserId: "abby", displayName: "Abby Nunes" }),
      ],
    );

  const groupsOf = (options: Parameters<typeof directoryGroups>[1]) =>
    directoryGroups(roster(), options).map((group) => [
      group.level,
      group.rows.map((row) => row.displayName),
    ]);

  it("groups the placed people in ladder order, and orders each group by name", () => {
    // "All" is the roster the guardian has placed, in ladder order, and the
    // order within a group is the name, not what anyone last said.
    expect(groupsOf({ filter: "all", search: "" })).toEqual([
      ["inner-circle", ["Ray Oster"]],
      ["other", ["Sam Okafor"]],
    ]);
  });

  it("holds every position but the placed ones back from All, and enters each on purpose", () => {
    // A queue, a dismissal and the reader's own row each answer a different
    // question than "who does Rome know", so none of the three pads All.
    expect(groupsOf({ filter: "all", search: "" }).map(([level]) => level)).toEqual([
      "inner-circle",
      "other",
    ]);
    expect(groupsOf({ filter: "unknown", search: "" })).toEqual([
      ["unknown", ["Abby Nunes", "Jonas Tan", "Jules"]],
    ]);
    expect(groupsOf({ filter: "stranger", search: "" })).toEqual([["stranger", ["Prize"]]]);
  });

  it("leaves the guardian to a search rather than a chip", () => {
    // No chip selects the guardian, and no chip carries them along either.
    expect(groupsOf({ filter: "inner-circle", search: "" }).map(([level]) => level)).not.toContain(
      "guardian",
    );
    expect(groupsOf({ filter: "all", search: "guardian" })).toEqual([
      ["guardian", ["Mock Guardian"]],
    ]);
  });

  it("reaches the address book through a search, whatever chip is lit", () => {
    expect(groupsOf({ filter: "inner-circle", search: "jonas" })).toEqual([
      ["unknown", ["Jonas Tan"]],
    ]);
  });

  it("drops a group nothing sits in rather than heading an empty one", () => {
    const groups = directoryGroups(peopleRows([person({ id: "ray" })], []), {
      filter: "all",
      search: "",
    });
    expect(groups.map((group) => group.level)).toEqual(["inner-circle"]);
  });
});

describe("levelCounts", () => {
  const people = { all: 9, guardian: 1, "inner-circle": 3, acquaintance: 4, other: 1 };
  const accounts = (over: Partial<AccountCounts> = {}): AccountCounts => ({
    unlinked: 6,
    linked: 12,
    dismissed: 2,
    ...over,
  });

  it("reads every number off the server, never off the loaded rows", () => {
    expect(levelCounts(people, accounts())).toEqual({
      unknown: 6,
      guardian: 1,
      "inner-circle": 3,
      acquaintance: 4,
      other: 1,
      stranger: 2,
    });
    // Linked accounts are counted under the person they resolve to, never again
    // as accounts — the two nouns describe one roster.
    expect(Object.values(levelCounts(people, accounts())).reduce((a, b) => a + b, 0)).toBe(
      9 + 6 + 2,
    );
  });

  it("counts whatever the read the view is on counts under Unknown", () => {
    // The stream's read is the accounts something has happened on, so its
    // Unknown is the senders waiting on a decision. The directory's is the whole
    // contacts list, so its Unknown is everyone Rome has not placed — a bigger
    // number describing a bigger listing, which is the one on screen.
    expect(levelCounts(people, accounts({ unlinked: 6 })).unknown).toBe(6);
    expect(levelCounts(people, accounts({ unlinked: 4_212 })).unknown).toBe(4_212);
  });
});

describe("rowHandle", () => {
  it("renders a WhatsApp account as its phone number", () => {
    const [row] = peopleRows(
      [],
      [contact({ channel: "whatsapp", channelUserId: "14155550142@s.whatsapp.net" })],
    );
    expect(rowHandle(row)).toBe("+1 (415) 555-0142");
  });

  it("falls back to the raw identifier on a channel with no phone shape", () => {
    const [row] = peopleRows([], [contact({ channel: "discord", channelUserId: "6128843201" })]);
    expect(rowHandle(row)).toBe("6128843201");
  });
});

describe("peoplePath", () => {
  it("gives each view its own address", () => {
    expect(peoplePath("latest", { filter: "all", search: "" })).toBe("/people/latest");
    expect(peoplePath("directory", { filter: "all", search: "" })).toBe("/people/directory");
  });

  it("carries the chip and the term, and leaves the defaults out", () => {
    expect(peoplePath("directory", { filter: "unknown", search: "" })).toBe(
      "/people/directory?level=unknown",
    );
    expect(peoplePath("latest", { filter: "all", search: "wei chen" })).toBe(
      "/people/latest?q=wei+chen",
    );
    expect(peoplePath("latest", { filter: "stranger", search: "wei" })).toBe(
      "/people/latest?level=stranger&q=wei",
    );
  });
});

describe("parsePeopleFilter", () => {
  it("takes the chips the rail offers", () => {
    expect(parsePeopleFilter("inner-circle")).toBe("inner-circle");
    expect(parsePeopleFilter("stranger")).toBe("stranger");
  });

  it("answers a missing or unoffered level with every level", () => {
    // Guardian is a ladder position with no chip, so an address naming it is
    // as unusable as one naming a level that never existed.
    expect(parsePeopleFilter("guardian")).toBe("all");
    expect(parsePeopleFilter("former-colleague")).toBe("all");
    expect(parsePeopleFilter(null)).toBe("all");
  });
});
