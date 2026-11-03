import { describe, expect, it } from "@rstest/core";
import type { AccountCounts, DirectoryAccount, PersonResource } from "@rome/api-types/people";
import {
  directoryGroups,
  levelCounts,
  parsePeopleFilter,
  peoplePath,
  peopleRows,
  rowHandle,
  type PeopleRow,
} from "./people-model";

// The People page reads two nouns — a person and the accounts they are reachable
// at — and renders one ladder over both. What is pinned here is the join: which
// contract row becomes which ladder position, how the contacts list orders,
// and whose numbers the chips and headings show. `contact` is the directory's
// row — everyone, and nothing about what was said.

function person(over: Partial<PersonResource> = {}): PersonResource {
  return {
    id: over.id ?? "ray-oster",
    displayName: "Ray Oster",
    bondLevel: "inner-circle",
    accounts: [{ channel: "telegram", channelUserId: "418820113", displayName: "Ray" }],
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
    expect(rows.map((row) => row.level)).toEqual(["stranger", "dismissed"]);
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

  it("leads with the guardian, then the placed people in ladder order, each group by name", () => {
    // "All" is the guardian's own row, where they read which accounts are
    // theirs, then the roster they have placed, in ladder order. The order
    // within a group is the name, not what anyone last said.
    expect(groupsOf({ filter: "all", search: "" })).toEqual([
      ["guardian", ["Mock Guardian"]],
      ["inner-circle", ["Ray Oster"]],
      ["other", ["Sam Okafor"]],
    ]);
  });

  it("holds the unplaced positions back from All, and enters each on purpose", () => {
    // A queue and a dismissal each answer a different question than "who does
    // Rome know", so neither pads All.
    expect(groupsOf({ filter: "all", search: "" }).map(([level]) => level)).toEqual([
      "guardian",
      "inner-circle",
      "other",
    ]);
    expect(groupsOf({ filter: "stranger", search: "" })).toEqual([
      ["stranger", ["Abby Nunes", "Jonas Tan", "Jules"]],
    ]);
    expect(groupsOf({ filter: "dismissed", search: "" })).toEqual([["dismissed", ["Prize"]]]);
  });

  it("gives the guardian no chip of their own", () => {
    // No chip selects the guardian, and a level chip does not carry them along.
    expect(groupsOf({ filter: "inner-circle", search: "" }).map(([level]) => level)).not.toContain(
      "guardian",
    );
    // By name: "guardian" would also match the level, and the level is not
    // what a search reads.
    expect(groupsOf({ filter: "all", search: "mock" })).toEqual([["guardian", ["Mock Guardian"]]]);
  });

  it("reaches the address book through a search, whatever chip is lit", () => {
    expect(groupsOf({ filter: "inner-circle", search: "jonas" })).toEqual([
      ["stranger", ["Jonas Tan"]],
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
      stranger: 6,
      guardian: 1,
      "inner-circle": 3,
      acquaintance: 4,
      other: 1,
      dismissed: 2,
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
    expect(levelCounts(people, accounts({ unlinked: 6 })).stranger).toBe(6);
    expect(levelCounts(people, accounts({ unlinked: 4_212 })).stranger).toBe(4_212);
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

  it("adds nothing under an agent the row already names by its label", () => {
    const [row] = peopleRows(
      [],
      [
        contact({
          channel: "agents",
          channelUserId: "0b6c5a1e-7d2f-4c3a-9e1b-5f8a2d4c6e01",
          displayName: "atlas (dot)",
        }),
      ],
    );
    expect(rowHandle(row)).toBeNull();
  });
});

describe("peoplePath", () => {
  it("carries the chip and the term, and leaves the defaults out", () => {
    expect(peoplePath({ filter: "all", search: "" })).toBe("/people/directory");
    expect(peoplePath({ filter: "stranger", search: "" })).toBe("/people/directory?level=stranger");
    expect(peoplePath({ filter: "all", search: "wei chen" })).toBe("/people/directory?q=wei+chen");
    expect(peoplePath({ filter: "dismissed", search: "wei" })).toBe(
      "/people/directory?level=dismissed&q=wei",
    );
  });
});

describe("parsePeopleFilter", () => {
  it("takes the chips the rail offers", () => {
    expect(parsePeopleFilter("inner-circle")).toBe("inner-circle");
    expect(parsePeopleFilter("dismissed")).toBe("dismissed");
  });

  it("answers a missing or unoffered level with every level", () => {
    // Guardian is a ladder position with no chip, so an address naming it is
    // as unusable as one naming a level that never existed.
    expect(parsePeopleFilter("guardian")).toBe("all");
    expect(parsePeopleFilter("former-colleague")).toBe("all");
    expect(parsePeopleFilter(null)).toBe("all");
  });
});
