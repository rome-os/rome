import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import {
  compareDisplayNames,
  type PeopleList,
  type LinkedAccount,
  type PersonResource,
} from "@rome/api-types/people";
import { phoneBookRoutes } from "../../../people/phone-book/index.js";
import {
  createTestDb,
  buildTestDeps,
  ownedByGuardian,
  type TestDb,
  type TestDeps,
} from "../../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../../test/seeds.js";
import { channels as channelRows } from "../../../db/schema.js";

// GET /people — the guardian's people, as the chat composer and the
// `core:list_people` action read them: who is listed, how each account is
// named and dated, and how the listing filters, counts and orders.

const at = (iso: string) => new Date(iso);

/** An account's naming, and only that. The assertions that use it are about
 *  which name a channel puts on an account; whether Rome can send there and
 *  when it was last active are separate answers on the same row, and a test
 *  about naming should not restate them. */
function naming(accounts: readonly LinkedAccount[]) {
  return accounts.map(({ channel, channelUserId, displayName }) => ({
    channel,
    channelUserId,
    displayName,
  }));
}

describe("People API", () => {
  const NADIA_JID = "15550001111@s.whatsapp.net";
  const NADIA_LID = "77771111@lid";

  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let baseline: BaselineIds;
  let nadiaId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    ownedByGuardian(testDb.db, deps.peopleRepo, baseline.persons.guardianId, [
      { channel: "whatsapp", platform: "whatsapp" },
    ]);
    app = new Hono().route("/", phoneBookRoutes(deps));

    // One WhatsApp account reachable two ways, which the mirror folds onto the
    // phone JID, and a person mapped under both of them.
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: NADIA_JID, phoneNumber: "15550001111", name: "Nadia Cross" },
      { jid: NADIA_LID, phoneNumber: "15550001111", notify: "Nadia" },
    ]);
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-n1",
        chatJid: NADIA_JID,
        senderJid: NADIA_JID,
        fromMe: false,
        timestamp: at("2026-08-10T09:00:00Z"),
        type: "text",
        text: "are we still on for friday",
        hasMedia: false,
      },
      {
        id: "wa-n2",
        chatJid: NADIA_JID,
        senderJid: NADIA_JID,
        fromMe: true,
        timestamp: at("2026-08-10T09:05:00Z"),
        type: "text",
        text: "yes — 7pm",
        hasMedia: false,
      },
      {
        id: "wa-n-react",
        chatJid: NADIA_JID,
        senderJid: NADIA_JID,
        fromMe: false,
        timestamp: at("2026-08-10T09:06:00Z"),
        type: "reaction",
        text: "👍",
        hasMedia: false,
        reactsToId: "wa-n2",
      },
      {
        id: "wa-n-group",
        chatJid: "120363000000000011@g.us",
        senderJid: NADIA_JID,
        fromMe: false,
        timestamp: at("2026-08-11T10:00:00Z"),
        type: "text",
        text: "posted in the group",
        hasMedia: false,
      },
    ]);

    nadiaId = await deps.peopleRepo.create({
      displayName: "Nadia Cross",
      bondLevel: "acquaintance",
      links: [
        { platform: "whatsapp", id: NADIA_JID },
        { platform: "whatsapp", id: NADIA_LID },
      ],
    });
  });

  afterEach(() => testDb.close());

  async function fetchList(query = ""): Promise<PeopleList> {
    const res = await app.request(`/people${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as PeopleList;
  }

  async function fetchPerson(id: string): Promise<PersonResource> {
    const person = (await fetchList()).people.find((listed) => listed.id === id);
    expect(person).toBeDefined();
    return person!;
  }

  it("lists every curated person with their accounts, and never the sentinel", async () => {
    const { people } = await fetchList();
    const ids = people.map((person) => person.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        baseline.persons.guardianId,
        baseline.persons.innerCircleId,
        baseline.persons.acquaintanceId,
        baseline.persons.otherId,
        nadiaId,
      ]),
    );

    const alice = people.find((person) => person.id === baseline.persons.innerCircleId);
    expect(naming(alice?.accounts ?? [])).toEqual([
      // Telegram mirrors no address book, so the name is the one the sender put
      // on their own messages — the directory seam's second fallback.
      { channel: "telegram", channelUserId: "tg-alice", displayName: "Alice Inner" },
    ]);

    const carol = people.find((person) => person.id === baseline.persons.otherId);
    // Nothing has ever named this account, so it is rendered as its identifier
    // rather than as an empty string.
    expect(naming(carol?.accounts ?? [])).toEqual([
      { channel: "whatsapp", channelUserId: "wa-carol", displayName: "wa-carol" },
    ]);
  });

  it("names an account as its platform does, over every address of it", async () => {
    const nadia = await fetchPerson(nadiaId);
    // One account, two mappings: a client addresses the link it stored, and
    // both carry the mirror's name for the account rather than the raw jid.
    // The listing promises no order among a person's accounts.
    const byAddress = naming(nadia.accounts).sort((a, b) =>
      a.channelUserId.localeCompare(b.channelUserId),
    );
    expect(byAddress).toEqual([
      { channel: "whatsapp", channelUserId: NADIA_JID, displayName: "Nadia Cross" },
      { channel: "whatsapp", channelUserId: NADIA_LID, displayName: "Nadia Cross" },
    ]);
  });

  it("keeps a stored bond level the ladder does not name, and counts it as other", async () => {
    // Older rows carry levels outside today's enum. Rewriting one on the way
    // out would make a person's own level unreadable.
    await testDb.db.run(
      sql`UPDATE persons SET bond_level = 'colleague' WHERE id = ${baseline.persons.otherId}`,
    );

    expect((await fetchPerson(baseline.persons.otherId)).bondLevel).toBe("colleague");

    const filtered = await fetchList("?level=other");
    expect(filtered.people.map((person) => person.id)).toContain(baseline.persons.otherId);
  });

  it("counts the whole match rather than the rows it returned", async () => {
    const whole = await fetchList();
    const narrowed = await fetchList("?level=inner-circle");

    expect(narrowed.people.map((person) => person.id)).toEqual([baseline.persons.innerCircleId]);
    // The chips are how the guardian leaves the level they are on, so every
    // number stays true while one of them is selected.
    expect(narrowed.counts).toEqual(whole.counts);
    expect(whole.counts.guardian).toBe(1);
    expect(whole.counts["inner-circle"]).toBe(1);
    expect(whole.counts.acquaintance).toBe(2);
    expect(whole.counts.other).toBe(1);
    expect(whole.counts.all).toBe(5);
  });

  it("narrows the match with ?q=, including by an account's identifier", async () => {
    const byName = await fetchList("?q=nadia");
    expect(byName.people.map((person) => person.id)).toEqual([nadiaId]);
    expect(byName.counts.all).toBe(1);
    expect(byName.counts.acquaintance).toBe(1);

    // A guardian searches with what they have — the phone number they were
    // given, not the name Rome saved.
    const byNumber = await fetchList("?q=15550001111");
    expect(byNumber.people.map((person) => person.id)).toEqual([nadiaId]);
  });

  it("refuses a level that names no view", async () => {
    const res = await app.request("/people?level=colleague");
    expect(res.status).toBe(400);
  });

  it("dates one account the same whatever address it is linked by", async () => {
    const nadia = await fetchPerson(nadiaId);
    // Two links onto one mirrored account, and one conversation on it: the
    // reaction and the group message are not entries, and the two addresses
    // are not two histories.
    const newest = Math.floor(at("2026-08-10T09:05:00Z").getTime() / 1000);
    expect(nadia.accounts.map((account) => account.latestAt)).toEqual([newest, newest]);
  });

  it("orders people by name", async () => {
    const { people } = await fetchList();
    const names = people.map((person) => person.displayName);
    expect(names).toEqual([...names].sort(compareDisplayNames));
  });

  it("answers a person with no accounts", async () => {
    const unreachable = await deps.peopleRepo.create({
      displayName: "No Channels",
      bondLevel: "other",
      links: [],
    });
    expect((await fetchPerson(unreachable)).accounts).toEqual([]);
  });

  // An account's history is read under every channel Rome has held on its
  // platform, so a listing asks about each account once per channel. With
  // channels released over time that outgrows one statement.
  it("lists many people on a platform Rome has held many channels on", async () => {
    for (let i = 0; i < 6; i++) {
      testDb.db
        .insert(channelRows)
        .values({
          id: `tg-released-${i}`,
          connectionKind: "telegram",
          platform: "telegram",
          createdAt: new Date(i),
        })
        .run();
    }
    const PEOPLE = 1000;
    for (let i = 0; i < PEOPLE; i++) {
      await deps.peopleRepo.create({
        displayName: `Telegram ${i}`,
        bondLevel: "other",
        links: [{ platform: "telegram", id: `tg-many-${i}` }],
      });
    }

    const res = await app.request("/people");

    expect(res.status).toBe(200);
    expect(((await res.json()) as PeopleList).people.length).toBeGreaterThanOrEqual(PEOPLE);
  }, 60_000);
});
describe("People delegate links", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let baseline: BaselineIds;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", phoneBookRoutes(deps));
  });

  afterEach(() => testDb.close());

  it("marks the agent's account and leaves the person's own unmarked", async () => {
    const guardian = baseline.persons.guardianId;
    deps.peopleRepo.linkDelegate({ platform: "agents", id: "agt-atlas" }, guardian);

    const list = (await (await app.request("/people")).json()) as PeopleList;
    const person = list.people.find((p) => p.id === guardian)!;

    const marks = Object.fromEntries(
      person.accounts.map((account) => [account.channelUserId, account.delegate ?? false]),
    );
    expect(marks["agt-atlas"]).toBe(true);
    expect(marks["tg-guardian"]).toBe(false);
  });
});
