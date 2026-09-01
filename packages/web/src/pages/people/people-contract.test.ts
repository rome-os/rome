import { describe, expect, it } from "@rstest/core";
import {
  accountMatchesQuery,
  compareCodePoints,
  compareDisplayNames,
  compareTimelineEntries,
  comparePeople,
  encodeStreamCursor,
  latestDynamic,
  normalizeBondLevel,
  parseStreamCursor,
  parseTimelineCursor,
  personMatchesQuery,
  timelineCursor,
  type StreamCursor,
  type DirectoryAccount,
  type PersonResource,
  type TimelineEntry,
} from "@rome/api-types/people";
import { protectedPersonReason, STRANGER_PERSON_ID } from "@rome/api-types/persons";

// The rules `@rome/api-types/people` holds that both ends have to agree on,
// exercised directly rather than through whichever surface happens to call
// them.
//
// They are here because two implementations run them at once — core's routes in
// Node, and mock mode's handlers in a browser — and every one of them is a
// place where "close enough" is a row skipped at a page boundary or a contact
// the guardian cannot find. A comparator that reads the host locale, a cursor
// that does not escape its parts, a search that does not normalize: none of
// those show up as a failure in the surface that calls them, only as a wrong
// answer.

const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  source: "whatsapp",
  timestamp: 100,
  body: null,
  direction: "inbound",
  ref: "r1",
  ...over,
});

const person = (over: Partial<PersonResource> & Pick<PersonResource, "id">): PersonResource => ({
  displayName: over.id,
  bondLevel: "other",
  accounts: [],
  messageCount: 0,
  latest: null,
  ...over,
});

const account = (
  over: Partial<DirectoryAccount> & Pick<DirectoryAccount, "channel" | "channelUserId">,
): DirectoryAccount => ({
  addresses: [over.channelUserId],
  displayName: over.channelUserId,
  state: "unlinked",
  personId: null,
  personName: null,
  ...over,
});

describe("timeline cursor", () => {
  it("round-trips a source and a ref carrying the separator", () => {
    const tricky = entry({ source: "app|notes", ref: "chat|1:msg|2" });
    const parsed = parseTimelineCursor(timelineCursor(tricky));

    expect(parsed?.source).toBe("app|notes");
    expect(parsed?.ref).toBe("chat|1:msg|2");
    // The decoded position has to compare equal to the entry it names, or the
    // next page resumes somewhere no entry sits.
    expect(compareTimelineEntries(parsed as TimelineEntry, tricky)).toBe(0);
  });

  it("keeps two entries whose separators would otherwise collide apart", () => {
    const a = entry({ source: "a|b", ref: "r" });
    const b = entry({ source: "a", ref: "b|r" });

    expect(timelineCursor(a)).not.toBe(timelineCursor(b));
    expect(compareTimelineEntries(a, b)).not.toBe(0);
  });

  it("rejects a value that is not a cursor", () => {
    expect(parseTimelineCursor("100|inbound|whatsapp")).toBeNull();
    expect(parseTimelineCursor("100|sideways|whatsapp|r1")).toBeNull();
    expect(parseTimelineCursor("|inbound|whatsapp|r1")).toBeNull();
    expect(parseTimelineCursor("100|inbound|whatsapp|")).toBeNull();
    expect(parseTimelineCursor("%E0%A4%A|inbound|whatsapp|r1")).toBeNull();
  });
});

describe("stream cursor", () => {
  const cursor = (over: Partial<StreamCursor> = {}): StreamCursor => ({
    timestamp: 300,
    displayName: "a|b",
    id: "whatsapp:41|7",
    ...over,
  });

  it("round-trips a name and an id carrying the separator", () => {
    // A display name is guardian-supplied text and an id carries a jid, so
    // neither can be trusted to avoid the separator: an unescaped one shifts
    // the split and resumes the page at a position no row occupies.
    expect(parseStreamCursor(encodeStreamCursor(cursor()))).toEqual(cursor());
  });

  it("round-trips a row that has never done anything", () => {
    expect(
      parseStreamCursor(encodeStreamCursor(cursor({ timestamp: null })))?.timestamp,
    ).toBeNull();
  });

  it("rejects a value that is not a cursor", () => {
    expect(parseStreamCursor("whatsapp:a")).toBeNull();
    expect(parseStreamCursor("nope|nope|")).toBeNull();
    expect(parseStreamCursor("%E0%A4%A|a|whatsapp:a")).toBeNull();
    expect(parseStreamCursor(null)).toBeNull();
  });
});

describe("orderings are total", () => {
  it("separates canonically equivalent but distinct strings", () => {
    // `localeCompare` answers 0 for this pair, which would make two distinct
    // entries share one cursor position.
    expect("é".localeCompare("e\u0301")).toBe(0);
    expect(compareCodePoints("é", "e\u0301")).not.toBe(0);

    expect(compareTimelineEntries(entry({ ref: "é" }), entry({ ref: "e\u0301" }))).not.toBe(0);
  });

  it("separates two people whose names differ only by normalization", () => {
    const at = { source: "whatsapp", timestamp: 300, preview: null };
    const a = person({ id: "a", displayName: "José", latest: at });
    const b = person({ id: "b", displayName: "Jose\u0301", latest: at });

    expect(comparePeople(a, b)).not.toBe(0);
  });

  it("orders a reply above the line it answers", () => {
    const inbound = entry({ direction: "inbound", ref: "msg" });
    const reply = entry({ direction: "outbound", ref: "msg:reply" });

    expect(compareTimelineEntries(reply, inbound)).toBeLessThan(0);
  });
});

describe("orderings do not depend on the host locale", () => {
  it("orders a pair that English and Swedish collation disagree about", () => {
    // The mock runs in a browser and the route runs in Node, so a comparator
    // that reads the host locale lets a cursor written by one skip rows for
    // the other. A code-point fallback repairs a tie, never an inversion.
    expect("ä".localeCompare("z", "en")).toBeLessThan(0);
    expect("ä".localeCompare("z", "sv")).toBeGreaterThan(0);
    expect(compareDisplayNames("ä", "z")).toBe(compareDisplayNames("ä", "z"));
    expect(compareDisplayNames("ä", "z")).toBeGreaterThan(0);
  });

  it("sits the same name in different cases together", () => {
    expect(compareDisplayNames("ada", "Ada")).not.toBe(0);
    expect(compareDisplayNames("Ada", "bob")).toBeLessThan(0);
  });
});

describe("what a search matches", () => {
  it("matches across Unicode normalization forms", () => {
    // A keyboard that composes "José" has to find a row that stored it
    // decomposed, and the reverse.
    expect(personMatchesQuery(person({ id: "x", displayName: "Jose\u0301" }), "José")).toBe(true);
    expect(personMatchesQuery(person({ id: "x", displayName: "José" }), "Jose\u0301")).toBe(true);
  });

  it("finds a person by an account they hold, not only by their name", () => {
    // A guardian searches with what they have: a phone number they were given,
    // a member id pasted from a profile URL. A saved name would otherwise hide
    // the account they are looking for.
    const priya = person({
      id: "priya",
      displayName: "Priya",
      accounts: [{ channel: "whatsapp", channelUserId: "6591234567", displayName: "Priya Nair" }],
    });

    expect(personMatchesQuery(priya, "6591234567")).toBe(true);
    expect(personMatchesQuery(priya, "Priya")).toBe(true);
  });

  it("finds a named account by the address behind it", () => {
    const named = account({
      channel: "whatsapp",
      channelUserId: "41755550111@lid",
      addresses: ["41755550111@lid", "41755550111@s.whatsapp.net"],
      displayName: "Clinic",
    });

    expect(accountMatchesQuery(named, "41755550111")).toBe(true);
    expect(accountMatchesQuery(named, "Clinic")).toBe(true);
  });
});

describe("latestDynamic", () => {
  const said = (over: Partial<TimelineEntry> = {}) => entry({ body: "hello", ...over });

  it("projects the head of the ordering, whatever it is", () => {
    // One definition of "newest". A second comparison would settle a same-second
    // tie on its own terms, and a row could preview one event while its timeline
    // opened on another.
    const inbound = said({ source: "telegram", direction: "inbound", ref: "a" });
    const outbound = said({ source: "whatsapp", direction: "outbound", ref: "b" });
    const ordered = [inbound, outbound].sort(compareTimelineEntries);

    expect(latestDynamic(ordered)).toEqual({
      source: ordered[0].source,
      timestamp: ordered[0].timestamp,
      preview: ordered[0].body,
    });
    // The reply wins the ordering, so it is what the row previews.
    expect(latestDynamic(ordered)?.source).toBe("whatsapp");
  });

  it("carries a null body through as a null preview", () => {
    expect(latestDynamic([said({ body: null })])?.preview).toBeNull();
  });

  it("is null for a row with no entries", () => {
    expect(latestDynamic([])).toBeNull();
  });
});

describe("normalizeBondLevel", () => {
  it("buckets a level off today's ladder rather than dropping the row", () => {
    // The column is free text and older rows carry values like this one, so a
    // reader that did not bucket them would drop the person from every group.
    expect(normalizeBondLevel("colleague")).toBe("other");
    expect(normalizeBondLevel("")).toBe("other");
  });

  it("refuses the two positions no person row holds", () => {
    // Unknown is an account with no link and stranger is a link onto the
    // sentinel; both are read off the links, so neither is ever stored.
    expect(normalizeBondLevel("unknown")).toBe("other");
    expect(normalizeBondLevel("stranger")).toBe("other");
  });

  it("passes a placed level through", () => {
    expect(normalizeBondLevel("inner-circle")).toBe("inner-circle");
    expect(normalizeBondLevel("guardian")).toBe("guardian");
  });
});

describe("protectedPersonReason", () => {
  it("refuses the guardian and the stranger sentinel", () => {
    expect(protectedPersonReason({ id: "ada", bondLevel: "guardian" })).toBe("guardian");
    // The sentinel carries an ordinary bond level, so its id is the only signal.
    expect(protectedPersonReason({ id: STRANGER_PERSON_ID, bondLevel: "other" })).toBe(
      "stranger-sentinel",
    );
  });

  it("accepts an ordinary person", () => {
    expect(protectedPersonReason({ id: "ada", bondLevel: "inner-circle" })).toBeNull();
  });
});
