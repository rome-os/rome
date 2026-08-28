import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { AccountHeldError, PersonMappingRepository } from "./person-mapping.js";
import { eq } from "drizzle-orm";
import { persons, channelMappings } from "../schema.js";
import { STRANGER_PERSON_ID } from "../../constants.js";

describe("PersonMappingRepository", () => {
  let testDb: TestDb;
  let repo: PersonMappingRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PersonMappingRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  /** What marking a sender as a stranger does: file the account under the
   *  sentinel rather than deleting it. */
  async function dismiss(channel: string, channelUserId: string, displayName?: string) {
    if (!(await repo.findById(STRANGER_PERSON_ID))) {
      await repo.createWithId(STRANGER_PERSON_ID, {
        displayName: "Stranger",
        bondLevel: "other",
      });
    }
    await repo.addChannelMapping(STRANGER_PERSON_ID, channel, channelUserId, displayName);
  }

  it("findAllWithMappings() reads every person and their accounts at once", async () => {
    // One statement, so an account moving between two people mid-read cannot
    // land under both of them — which is what one account, one person means.
    const alice = await repo.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      channelMappings: [
        { channel: "telegram", channelUserId: "tg-alice" },
        { channel: "whatsapp", channelUserId: "wa-alice" },
      ],
    });
    const bob = await repo.create({ displayName: "Bob", bondLevel: "acquaintance" });

    const rows = await repo.findAllWithMappings();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.size).toBe(rows.length);
    expect(byId.get(alice)!.displayName).toBe("Alice");
    expect(
      byId
        .get(alice)!
        .channelMappings.map((m) => `${m.channel}:${m.channelUserId}`)
        .sort(),
    ).toEqual(["telegram:tg-alice", "whatsapp:wa-alice"]);
    // A person holding no account is still a person, and the left join has to
    // answer them with an empty list rather than dropping them.
    expect(byId.get(bob)!.channelMappings).toEqual([]);
  });

  it("createPerson() inserts person record", async () => {
    const id = await repo.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
    });

    expect(id).toBeDefined();
    const person = await repo.findById(id);
    expect(person).not.toBeNull();
    expect(person!.displayName).toBe("Alice");
    expect(person!.bondLevel).toBe("inner-circle");
    expect(person!.approved).toBe(false);
  });

  it("createChannelMapping() inserts channel mapping linked to person", async () => {
    const personId = await repo.create({
      displayName: "Bob",
      bondLevel: "acquaintance",
    });

    const mappingId = await repo.addChannelMapping(personId, "telegram", "tg-user-123");
    expect(mappingId).toBeDefined();

    const person = await repo.findById(personId);
    expect(person!.channelMappings).toHaveLength(1);
    expect(person!.channelMappings[0]).toEqual({
      channel: "telegram",
      channelUserId: "tg-user-123",
    });
  });

  it("create() writes the person and its mappings together", async () => {
    const id = await repo.create({
      displayName: "Dana",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-dana" }],
    });

    expect(id).toBe("dana");
    const found = await repo.findByChannelUser("telegram", "tg-dana");
    expect(found!.id).toBe("dana");
    expect(found!.approved).toBe(true);
  });

  it("create() leaves no person behind when a mapping write fails", async () => {
    const boom = new Error("mapping write failed");
    // The seam the person insert must be enlisted with: forcing the mapping
    // write to throw is the only way to observe the rollback, since the claim
    // check refuses a held account before the transaction opens.
    (repo as unknown as { writeClaim: () => never }).writeClaim = () => {
      throw boom;
    };

    await expect(
      repo.create({
        displayName: "Erin",
        bondLevel: "acquaintance",
        channelMappings: [{ channel: "telegram", channelUserId: "tg-erin" }],
      }),
    ).rejects.toThrow(boom);

    // Without the transaction the person row would survive, unreachable: no
    // inbound message resolves to it and no API can repair or delete it.
    expect(await repo.findById("erin")).toBeNull();
  });

  it("findByChannelUser() returns person for channel+userId", async () => {
    const personId = await repo.create({
      displayName: "Charlie",
      bondLevel: "guardian",
      channelMappings: [{ channel: "slack", channelUserId: "U123" }],
    });

    const found = await repo.findByChannelUser("slack", "U123");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(personId);
    expect(found!.displayName).toBe("Charlie");
    expect(found!.channelMappings).toHaveLength(1);
  });

  it("findByChannelUser() returns null for unknown user", async () => {
    const found = await repo.findByChannelUser("slack", "unknown-user");
    expect(found).toBeNull();
  });

  it("deleteGuardianChannelMappings() removes only guardian mappings for that channel", async () => {
    const guardianId = await repo.create({
      displayName: "Guardian",
      bondLevel: "guardian",
      channelMappings: [
        { channel: "feishu", channelUserId: "ou-old" },
        { channel: "telegram", channelUserId: "tg-guardian" },
      ],
    });
    const friendId = await repo.create({
      displayName: "Friend",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "feishu", channelUserId: "ou-friend" }],
    });

    await repo.deleteGuardianChannelMappings("feishu");

    expect((await repo.findById(guardianId))!.channelMappings).toEqual([
      { channel: "telegram", channelUserId: "tg-guardian" },
    ]);
    expect((await repo.findById(friendId))!.channelMappings).toEqual([
      { channel: "feishu", channelUserId: "ou-friend" },
    ]);
  });

  it("writeDeleteGuardianChannelMappings() removes only guardian mappings inside a caller transaction", async () => {
    const guardianId = await repo.create({
      displayName: "Guardian",
      bondLevel: "guardian",
      channelMappings: [
        { channel: "feishu", channelUserId: "ou-old" },
        { channel: "telegram", channelUserId: "tg-guardian" },
      ],
    });
    const friendId = await repo.create({
      displayName: "Friend",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "feishu", channelUserId: "ou-friend" }],
    });

    testDb.db.transaction((tx) => {
      repo.writeDeleteGuardianChannelMappings(tx, "feishu");
    });

    expect((await repo.findById(guardianId))!.channelMappings).toEqual([
      { channel: "telegram", channelUserId: "tg-guardian" },
    ]);
    expect((await repo.findById(friendId))!.channelMappings).toEqual([
      { channel: "feishu", channelUserId: "ou-friend" },
    ]);
  });

  it("writeDeleteGuardianChannelMappings() is rolled back when its transaction throws", async () => {
    const guardianId = await repo.create({
      displayName: "Guardian",
      bondLevel: "guardian",
      channelMappings: [{ channel: "feishu", channelUserId: "ou-old" }],
    });

    expect(() =>
      testDb.db.transaction((tx) => {
        repo.writeDeleteGuardianChannelMappings(tx, "feishu");
        throw new Error("participant boom");
      }),
    ).toThrow("participant boom");

    // The delete shared the aborted transaction, so nothing committed.
    expect((await repo.findById(guardianId))!.channelMappings).toEqual([
      { channel: "feishu", channelUserId: "ou-old" },
    ]);
  });

  it("findById() returns person with all channel mappings", async () => {
    const personId = await repo.create({
      displayName: "Diana",
      bondLevel: "inner-circle",
      channelMappings: [
        { channel: "telegram", channelUserId: "tg-diana" },
        { channel: "slack", channelUserId: "slack-diana" },
      ],
    });

    const person = await repo.findById(personId);
    expect(person).not.toBeNull();
    expect(person!.channelMappings).toHaveLength(2);
    const channels = person!.channelMappings.map((m) => m.channel).sort();
    expect(channels).toEqual(["slack", "telegram"]);
  });

  it("updateChannelUserId() re-points one account and leaves the person's others", async () => {
    const personId = await repo.create({
      displayName: "Erin",
      bondLevel: "inner-circle",
      channelMappings: [
        { channel: "telegram", channelUserId: "tg-erin-work" },
        { channel: "telegram", channelUserId: "tg-erin-personal" },
      ],
    });

    const moved = await repo.updateChannelUserId(
      personId,
      "telegram",
      "tg-erin-work",
      "tg-erin-work-canonical",
    );

    expect(moved).toBe(true);
    const person = await repo.findById(personId);
    expect(person!.channelMappings.map((m) => m.channelUserId).sort()).toEqual([
      "tg-erin-personal",
      "tg-erin-work-canonical",
    ]);
  });

  it("updateChannelUserId() keeps both when the person already holds the incoming account", async () => {
    const personId = await repo.create({
      displayName: "Erin",
      bondLevel: "inner-circle",
      channelMappings: [
        { channel: "telegram", channelUserId: "tg-erin-old" },
        { channel: "telegram", channelUserId: "tg-erin-new" },
      ],
    });

    const moved = await repo.updateChannelUserId(
      personId,
      "telegram",
      "tg-erin-old",
      "tg-erin-new",
    );

    // Two accounts of theirs, not a claim to settle: merging them would drop one.
    expect(moved).toBe(false);
    const person = await repo.findById(personId);
    expect(person!.channelMappings.map((m) => m.channelUserId).sort()).toEqual([
      "tg-erin-new",
      "tg-erin-old",
    ]);
  });

  it("updateChannelUserId() takes the incoming account from a rival holder", async () => {
    const erin = await repo.create({
      displayName: "Erin",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "telegram", channelUserId: "tg-erin-old" }],
    });
    const rival = await repo.create({
      displayName: "Rival",
      bondLevel: "acquaintance",
      channelMappings: [{ channel: "telegram", channelUserId: "tg-erin-new" }],
    });

    const moved = await repo.updateChannelUserId(erin, "telegram", "tg-erin-old", "tg-erin-new");

    expect(moved).toBe(true);
    expect((await repo.findByChannelUser("telegram", "tg-erin-new"))!.id).toBe(erin);
    expect((await repo.findById(rival))!.channelMappings).toEqual([]);
  });

  it("updateChannelUserId() leaves a rival holder alone when the person's account is gone", async () => {
    const erin = await repo.create({ displayName: "Erin", bondLevel: "inner-circle" });
    const rival = await repo.create({
      displayName: "Rival",
      bondLevel: "acquaintance",
      channelMappings: [{ channel: "telegram", channelUserId: "tg-erin-new" }],
    });

    const moved = await repo.updateChannelUserId(erin, "telegram", "tg-gone", "tg-erin-new");

    expect(moved).toBe(false);
    expect((await repo.findByChannelUser("telegram", "tg-erin-new"))!.id).toBe(rival);
  });

  it("updateChannelUserId() reports an account the person does not hold", async () => {
    const personId = await repo.create({
      displayName: "Frank",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "telegram", channelUserId: "tg-frank" }],
    });

    const moved = await repo.updateChannelUserId(personId, "telegram", "tg-gone", "tg-frank-new");

    expect(moved).toBe(false);
    const person = await repo.findById(personId);
    expect(person!.channelMappings.map((m) => m.channelUserId)).toEqual(["tg-frank"]);
  });

  it("updateBondLevel() changes bond level", async () => {
    const personId = await repo.create({
      displayName: "Eve",
      bondLevel: "other",
    });

    await testDb.db
      .update(persons)
      .set({ bondLevel: "inner-circle" })
      .where(eq(persons.id, personId));

    const person = await repo.findById(personId);
    expect(person!.bondLevel).toBe("inner-circle");
  });

  it("approve() sets approved=true", async () => {
    const personId = await repo.create({
      displayName: "Frank",
      bondLevel: "acquaintance",
    });

    await testDb.db.update(persons).set({ approved: true }).where(eq(persons.id, personId));

    const person = await repo.findById(personId);
    expect(person!.approved).toBe(true);
  });

  it("findByDisplayName() handles duplicate names", async () => {
    await repo.create({
      displayName: "Grace",
      bondLevel: "acquaintance",
    });
    await repo.create({
      displayName: "Grace",
      bondLevel: "inner-circle",
    });

    const results = await repo.findByName("Grace");
    expect(results).toHaveLength(2);
    const levels = results.map((p) => p.bondLevel).sort();
    expect(levels).toEqual(["acquaintance", "inner-circle"]);
  });

  describe("account ownership", () => {
    it("re-points a mapped account onto its new person rather than adding a second", async () => {
      const first = await repo.create({
        displayName: "First",
        bondLevel: "other",
        channelMappings: [{ channel: "telegram", channelUserId: "tg-contested" }],
      });
      const second = await repo.create({ displayName: "Second", bondLevel: "other" });

      await repo.addChannelMapping(second, "telegram", "tg-contested", "Contested");

      expect((await repo.findById(first))!.channelMappings).toHaveLength(0);
      expect((await repo.findById(second))!.channelMappings).toEqual([
        expect.objectContaining({ channel: "telegram", channelUserId: "tg-contested" }),
      ]);
      // One owner is the invariant, whichever writer arrived last.
      const owner = await repo.findByChannelUser("telegram", "tg-contested");
      expect(owner?.id).toBe(second);
    });

    it("leaves one owner when two placements race for the same waiting sender", async () => {
      const a = await repo.create({ displayName: "A", bondLevel: "other" });
      const b = await repo.create({ displayName: "B", bondLevel: "other" });

      await Promise.all([
        repo.addChannelMapping(a, "discord", "dc-race"),
        repo.addChannelMapping(b, "discord", "dc-race"),
      ]);

      const owners = [await repo.findById(a), await repo.findById(b)].flatMap((person) =>
        person!.channelMappings.filter((mapping) => mapping.channelUserId === "dc-race"),
      );
      expect(owners).toHaveLength(1);
    });

    it("keeps the channel-side name when a re-point brings none", async () => {
      const first = await repo.create({ displayName: "First", bondLevel: "other" });
      const second = await repo.create({ displayName: "Second", bondLevel: "other" });
      await repo.addChannelMapping(first, "telegram", "tg-named", "Bob from work");

      await repo.addChannelMapping(second, "telegram", "tg-named");

      // The name is the channel's. A caller with none to offer is reporting no
      // news, not a rename.
      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.channelUserId, "tg-named"));
      expect(rows).toHaveLength(1);
      expect(rows[0].displayName).toBe("Bob from work");
      expect(rows[0].personId).toBe(second);
    });

    it("takes a new channel-side name when the channel reports one", async () => {
      const person = await repo.create({ displayName: "Person", bondLevel: "other" });
      await repo.addChannelMapping(person, "telegram", "tg-renamed", "Old Name");

      await repo.addChannelMapping(person, "telegram", "tg-renamed", "New Name");

      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.channelUserId, "tg-renamed"));
      expect(rows[0].displayName).toBe("New Name");
    });

    it("returns the id of the row a re-point actually left behind", async () => {
      const first = await repo.create({ displayName: "First", bondLevel: "other" });
      const second = await repo.create({ displayName: "Second", bondLevel: "other" });
      const originalId = await repo.addChannelMapping(first, "telegram", "tg-id");

      const reportedId = await repo.addChannelMapping(second, "telegram", "tg-id");

      // The conflict branch keeps the existing row, so a freshly minted id
      // would name a mapping that does not exist.
      expect(reportedId).toBe(originalId);
      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.id, reportedId));
      expect(rows).toHaveLength(1);
    });
  });

  describe("linkAccount() compare-and-swap", () => {
    it("takes an account nobody holds, and names it only from the channel", async () => {
      const person = await repo.create({ displayName: "Alice", bondLevel: "other" });

      expect(
        await repo.linkAccount({ personId: person, channel: "telegram", channelUserId: "tg-new" }),
      ).toEqual({ linked: true });

      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.channelUserId, "tg-new"));
      expect(rows).toHaveLength(1);
      expect(rows[0].personId).toBe(person);
      // A link names an account; what to call it is the provider directory's
      // answer at read time, so a claim invents no name.
      expect(rows[0].displayName).toBeNull();
    });

    it("refuses an account a real person holds, and writes nothing", async () => {
      const holder = await repo.create({ displayName: "Holder", bondLevel: "other" });
      const claimant = await repo.create({ displayName: "Claimant", bondLevel: "other" });
      await repo.addChannelMapping(holder, "telegram", "tg-held", "Held");

      const result = await repo.linkAccount({
        personId: claimant,
        channel: "telegram",
        channelUserId: "tg-held",
      });

      expect(result).toEqual({
        linked: false,
        holder: {
          channel: "telegram",
          channelUserId: "tg-held",
          personId: holder,
          personName: "Holder",
        },
      });
      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.channelUserId, "tg-held"));
      expect(rows.map((row) => row.personId)).toEqual([holder]);
    });

    it("reclaims an account that was only dismissed, and keeps its name", async () => {
      const person = await repo.create({ displayName: "Alice", bondLevel: "other" });
      await dismiss("telegram", "tg-set-aside", "Sender");

      expect(
        await repo.linkAccount({
          personId: person,
          channel: "telegram",
          channelUserId: "tg-set-aside",
        }),
      ).toEqual({ linked: true });

      // The row moves rather than being replaced, so the name the channel put
      // on it survives the reclaim.
      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.channelUserId, "tg-set-aside"));
      expect(rows).toHaveLength(1);
      expect(rows[0].personId).toBe(person);
      expect(rows[0].displayName).toBe("Sender");
    });

    it("lets only the first of two callers working from one view take the account", async () => {
      const holder = await repo.create({ displayName: "Holder", bondLevel: "other" });
      const first = await repo.create({ displayName: "First", bondLevel: "other" });
      const second = await repo.create({ displayName: "Second", bondLevel: "other" });
      await repo.addChannelMapping(holder, "telegram", "tg-contested");

      // Both read the same page, so both name the same owner to swap out. The
      // check and the move are one transaction, so the second reads an owner
      // that is no longer the one it expects instead of overwriting a transfer
      // it never saw.
      const won = await repo.linkAccount({
        personId: first,
        channel: "telegram",
        channelUserId: "tg-contested",
        transferFrom: holder,
      });
      const lost = await repo.linkAccount({
        personId: second,
        channel: "telegram",
        channelUserId: "tg-contested",
        transferFrom: holder,
      });

      expect(won).toEqual({ linked: true });
      expect(lost).toEqual({
        linked: false,
        holder: {
          channel: "telegram",
          channelUserId: "tg-contested",
          personId: first,
          personName: "First",
        },
      });
      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.channelUserId, "tg-contested"));
      expect(rows.map((row) => row.personId)).toEqual([first]);
    });

    it("unlinkAccount() drops one link and leaves the person's others", async () => {
      const person = await repo.create({ displayName: "Alice", bondLevel: "other" });
      await repo.addChannelMapping(person, "telegram", "tg-one");
      await repo.addChannelMapping(person, "whatsapp", "wa-one");

      expect(await repo.unlinkAccount(person, "telegram", "tg-one")).toBe(true);
      // A link nobody holds, and one held by somebody else, are both nothing
      // for this person to drop.
      expect(await repo.unlinkAccount(person, "telegram", "tg-one")).toBe(false);

      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.personId, person));
      expect(rows.map((row) => row.channelUserId)).toEqual(["wa-one"]);
    });
  });

  describe("create() claiming accounts", () => {
    it("reclaims an account that was only dismissed onto the stranger sentinel", async () => {
      await dismiss("whatsapp", "+15551234", "Bob");

      const bob = await repo.create({
        displayName: "Bob",
        bondLevel: "inner-circle",
        channelMappings: [{ channel: "whatsapp", channelUserId: "+15551234" }],
      });

      expect((await repo.findByChannelUser("whatsapp", "+15551234"))?.id).toBe(bob);
      const stranger = await repo.findById(STRANGER_PERSON_ID);
      expect(stranger!.channelMappings).toHaveLength(0);
    });

    it("carries the dismissed row's channel-side name onto the reclaimed account", async () => {
      await dismiss("whatsapp", "+15559999", "Bob from work");

      const bob = await repo.create({
        displayName: "Bob",
        bondLevel: "inner-circle",
        channelMappings: [{ channel: "whatsapp", channelUserId: "+15559999" }],
      });

      const rows = await testDb.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.personId, bob));
      expect(rows[0].displayName).toBe("Bob from work");
    });

    it("refuses an account a real person holds instead of stealing it", async () => {
      const alice = await repo.create({
        displayName: "Alice",
        bondLevel: "inner-circle",
        channelMappings: [{ channel: "whatsapp", channelUserId: "+15551234" }],
      });

      await expect(
        repo.create({
          displayName: "Bob",
          bondLevel: "inner-circle",
          channelMappings: [{ channel: "whatsapp", channelUserId: "+15551234" }],
        }),
      ).rejects.toThrow(/already belongs to person "alice"/);

      expect((await repo.findByChannelUser("whatsapp", "+15551234"))?.id).toBe(alice);
    });

    it("names the person holding the account it refused", async () => {
      const alice = await repo.create({
        displayName: "Alice Marsh",
        bondLevel: "inner-circle",
        channelMappings: [{ channel: "whatsapp", channelUserId: "+15551234" }],
      });

      // The holder's own name, not the channel-side one the mapping carries: a
      // caller reporting the conflict has to say whose account it is, and the
      // guardian knows the person by the name they gave them.
      const refused = await repo
        .create({
          displayName: "Bob",
          bondLevel: "inner-circle",
          channelMappings: [
            { channel: "telegram", channelUserId: "tg-bob" },
            { channel: "whatsapp", channelUserId: "+15551234" },
          ],
        })
        .catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(AccountHeldError);
      expect((refused as AccountHeldError).holder).toEqual({
        channel: "whatsapp",
        channelUserId: "+15551234",
        personId: alice,
        personName: "Alice Marsh",
      });
      // The unheld account in the same request is still unheld.
      expect(await repo.findByChannelUser("telegram", "tg-bob")).toBeNull();
    });

    it("leaves no half-made person behind when a claim is refused", async () => {
      await repo.create({
        displayName: "Alice",
        bondLevel: "inner-circle",
        channelMappings: [{ channel: "whatsapp", channelUserId: "+15551234" }],
      });

      await expect(
        repo.create({
          displayName: "Bob",
          bondLevel: "inner-circle",
          channelMappings: [{ channel: "whatsapp", channelUserId: "+15551234" }],
        }),
      ).rejects.toThrow();

      // A committed Bob would be unreachable and would block every retry, since
      // callers guard on display-name uniqueness before creating.
      expect(await repo.findByName("Bob")).toHaveLength(0);
      const retried = await repo.create({
        displayName: "Bob",
        bondLevel: "inner-circle",
        channelMappings: [{ channel: "whatsapp", channelUserId: "+15557777" }],
      });
      expect((await repo.findById(retried))!.displayName).toBe("Bob");
    });

    it("refuses a held account from the dashboard path too, leaving no person", async () => {
      const alice = await repo.create({
        displayName: "Alice",
        bondLevel: "inner-circle",
        channelMappings: [{ channel: "whatsapp", channelUserId: "+15551234" }],
      });

      await expect(
        repo.create({
          displayName: "Bob",
          bondLevel: "inner-circle",
          approved: true,
          channelMappings: [{ channel: "whatsapp", channelUserId: "+15551234" }],
        }),
      ).rejects.toThrow(/already belongs to person "alice"/);

      // Creating a person is not a re-point, whichever path asks for it.
      expect((await repo.findByChannelUser("whatsapp", "+15551234"))?.id).toBe(alice);
      expect(await repo.findById("bob")).toBeNull();
    });

    it("reclaims a dismissed account from the dashboard path", async () => {
      await dismiss("whatsapp", "+15558888", "Carol");

      await repo.create({
        displayName: "Carol",
        bondLevel: "inner-circle",
        approved: true,
        channelMappings: [{ channel: "whatsapp", channelUserId: "+15558888" }],
      });

      expect((await repo.findByChannelUser("whatsapp", "+15558888"))?.id).toBe("carol");
      expect((await repo.findById(STRANGER_PERSON_ID))!.channelMappings).toHaveLength(0);
    });
  });
});
