import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import {
  createTestDb,
  type TestDb,
  identityConnectionKindOf,
  recordedConnectionKindOf,
  testAccountLinkOf,
} from "../../test/helpers.js";
import { AccountHeldError, PeopleRepository } from "./people.js";
import { eq } from "drizzle-orm";
import { persons, links, dismissedAccounts } from "../schema.js";
import { ChannelRecordsRepository } from "./channel-records.js";

describe("PeopleRepository", () => {
  let testDb: TestDb;
  let repo: PeopleRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PeopleRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  /** A dismissal, written as the table holds one. */
  async function dismiss(platform: string, accountId: string) {
    testDb.db.insert(dismissedAccounts).values({ platform, accountId }).run();
  }

  it("all() reads every person and their accounts at once", async () => {
    // One statement, so an account moving between two people mid-read cannot
    // land under both of them — which is what one account, one person means.
    const alice = await repo.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      links: [
        { platform: "telegram", id: "tg-alice" },
        { platform: "whatsapp", id: "wa-alice" },
      ],
    });
    const bob = await repo.create({ displayName: "Bob", bondLevel: "acquaintance" });

    const rows = await repo.all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.size).toBe(rows.length);
    expect(byId.get(alice)!.displayName).toBe("Alice");
    expect(
      byId
        .get(alice)!
        .links.map((m) => `${m.platform}:${m.id}`)
        .sort(),
    ).toEqual(["telegram:tg-alice", "whatsapp:wa-alice"]);
    // A person holding no account is still a person, and the left join has to
    // answer them with an empty list rather than dropping them.
    expect(byId.get(bob)!.links).toEqual([]);
  });

  it("createPerson() inserts person record", async () => {
    const id = await repo.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
    });

    expect(id).toBeDefined();
    const person = await repo.byId(id);
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

    const mappingId = await repo.linkStated({ platform: "telegram", id: "tg-user-123" }, personId);
    expect(mappingId).toBeDefined();

    const person = await repo.byId(personId);
    expect(person!.links).toHaveLength(1);
    expect(person!.links[0]).toEqual({
      platform: "telegram",
      id: "tg-user-123",
    });
  });

  it("create() writes the person and its mappings together", async () => {
    const id = await repo.create({
      displayName: "Dana",
      bondLevel: "acquaintance",
      approved: true,
      links: [{ platform: "telegram", id: "tg-dana" }],
    });

    expect(id).toBe("dana");
    const found = await repo.byAccount({ platform: "telegram", id: "tg-dana" });
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
        links: [{ platform: "telegram", id: "tg-erin" }],
      }),
    ).rejects.toThrow(boom);

    // Without the transaction the person row would survive, unreachable: no
    // inbound message resolves to it and no API can repair or delete it.
    expect(await repo.byId("erin")).toBeNull();
  });

  it("findByChannelUser() returns person for channel+userId", async () => {
    const personId = await repo.create({
      displayName: "Charlie",
      bondLevel: "guardian",
      links: [{ platform: "slack", id: "U123" }],
    });

    const found = await repo.byAccount({ platform: "slack", id: "U123" });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(personId);
    expect(found!.displayName).toBe("Charlie");
    expect(found!.links).toHaveLength(1);
  });

  it("findByChannelUser() returns null for unknown user", async () => {
    const found = await repo.byAccount({ platform: "slack", id: "unknown-user" });
    expect(found).toBeNull();
  });

  it("findById() returns person with all channel mappings", async () => {
    const personId = await repo.create({
      displayName: "Diana",
      bondLevel: "inner-circle",
      links: [
        { platform: "telegram", id: "tg-diana" },
        { platform: "slack", id: "slack-diana" },
      ],
    });

    const person = await repo.byId(personId);
    expect(person).not.toBeNull();
    expect(person!.links).toHaveLength(2);
    const channels = person!.links.map((m) => m.platform).sort();
    expect(channels).toEqual(["slack", "telegram"]);
  });

  it("readdress() re-points one account and leaves the person's others", async () => {
    const personId = await repo.create({
      displayName: "Erin",
      bondLevel: "inner-circle",
      links: [
        { platform: "telegram", id: "tg-erin-work" },
        { platform: "telegram", id: "tg-erin-personal" },
      ],
    });

    const moved = await repo.readdress(
      personId,
      { platform: "telegram", id: "tg-erin-work" },
      "tg-erin-work-canonical",
    );

    expect(moved).toBe(true);
    const person = await repo.byId(personId);
    expect(person!.links.map((m) => m.id).sort()).toEqual([
      "tg-erin-personal",
      "tg-erin-work-canonical",
    ]);
  });

  it("readdress() keeps both when the person already holds the incoming account", async () => {
    const personId = await repo.create({
      displayName: "Erin",
      bondLevel: "inner-circle",
      links: [
        { platform: "telegram", id: "tg-erin-old" },
        { platform: "telegram", id: "tg-erin-new" },
      ],
    });

    const moved = await repo.readdress(
      personId,
      { platform: "telegram", id: "tg-erin-old" },
      "tg-erin-new",
    );

    // Two accounts of theirs, not a claim to settle: merging them would drop one.
    expect(moved).toBe(false);
    const person = await repo.byId(personId);
    expect(person!.links.map((m) => m.id).sort()).toEqual(["tg-erin-new", "tg-erin-old"]);
  });

  it("readdress() takes the incoming account from a rival holder", async () => {
    const erin = await repo.create({
      displayName: "Erin",
      bondLevel: "inner-circle",
      links: [{ platform: "telegram", id: "tg-erin-old" }],
    });
    const rival = await repo.create({
      displayName: "Rival",
      bondLevel: "acquaintance",
      links: [{ platform: "telegram", id: "tg-erin-new" }],
    });

    const moved = await repo.readdress(
      erin,
      { platform: "telegram", id: "tg-erin-old" },
      "tg-erin-new",
    );

    expect(moved).toBe(true);
    expect((await repo.byAccount({ platform: "telegram", id: "tg-erin-new" }))!.id).toBe(erin);
    expect((await repo.byId(rival))!.links).toEqual([]);
  });

  it("readdress() leaves a rival holder alone when the person's account is gone", async () => {
    const erin = await repo.create({ displayName: "Erin", bondLevel: "inner-circle" });
    const rival = await repo.create({
      displayName: "Rival",
      bondLevel: "acquaintance",
      links: [{ platform: "telegram", id: "tg-erin-new" }],
    });

    const moved = await repo.readdress(
      erin,
      { platform: "telegram", id: "tg-gone" },
      "tg-erin-new",
    );

    expect(moved).toBe(false);
    expect((await repo.byAccount({ platform: "telegram", id: "tg-erin-new" }))!.id).toBe(rival);
  });

  it("readdress() reports an account the person does not hold", async () => {
    const personId = await repo.create({
      displayName: "Frank",
      bondLevel: "inner-circle",
      links: [{ platform: "telegram", id: "tg-frank" }],
    });

    const moved = await repo.readdress(
      personId,
      { platform: "telegram", id: "tg-gone" },
      "tg-frank-new",
    );

    expect(moved).toBe(false);
    const person = await repo.byId(personId);
    expect(person!.links.map((m) => m.id)).toEqual(["tg-frank"]);
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

    const person = await repo.byId(personId);
    expect(person!.bondLevel).toBe("inner-circle");
  });

  it("approve() sets approved=true", async () => {
    const personId = await repo.create({
      displayName: "Frank",
      bondLevel: "acquaintance",
    });

    await testDb.db.update(persons).set({ approved: true }).where(eq(persons.id, personId));

    const person = await repo.byId(personId);
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

    const results = await repo.byName("Grace");
    expect(results).toHaveLength(2);
    const levels = results.map((p) => p.bondLevel).sort();
    expect(levels).toEqual(["acquaintance", "inner-circle"]);
  });

  describe("account ownership", () => {
    it("re-points a mapped account onto its new person rather than adding a second", async () => {
      const first = await repo.create({
        displayName: "First",
        bondLevel: "other",
        links: [{ platform: "telegram", id: "tg-contested" }],
      });
      const second = await repo.create({ displayName: "Second", bondLevel: "other" });

      await repo.linkStated({ platform: "telegram", id: "tg-contested" }, second);

      expect((await repo.byId(first))!.links).toHaveLength(0);
      expect((await repo.byId(second))!.links).toEqual([
        expect.objectContaining({ platform: "telegram", id: "tg-contested" }),
      ]);
      // One owner is the invariant, whichever writer arrived last.
      const owner = await repo.byAccount({ platform: "telegram", id: "tg-contested" });
      expect(owner?.id).toBe(second);
    });

    it("leaves one owner when two placements race for the same waiting sender", async () => {
      const a = await repo.create({ displayName: "A", bondLevel: "other" });
      const b = await repo.create({ displayName: "B", bondLevel: "other" });

      await Promise.all([
        repo.linkStated({ platform: "discord", id: "dc-race" }, a),
        repo.linkStated({ platform: "discord", id: "dc-race" }, b),
      ]);

      const owners = [await repo.byId(a), await repo.byId(b)].flatMap((person) =>
        person!.links.filter((mapping) => mapping.id === "dc-race"),
      );
      expect(owners).toHaveLength(1);
    });

    it("returns the id of the row a re-point actually left behind", async () => {
      const first = await repo.create({ displayName: "First", bondLevel: "other" });
      const second = await repo.create({ displayName: "Second", bondLevel: "other" });
      const originalId = await repo.linkStated({ platform: "telegram", id: "tg-id" }, first);

      const reportedId = await repo.linkStated({ platform: "telegram", id: "tg-id" }, second);

      // The conflict branch keeps the existing row, so a freshly minted id
      // would name a mapping that does not exist.
      expect(reportedId).toBe(originalId);
      const rows = await testDb.db.select().from(links).where(eq(links.id, reportedId));
      expect(rows).toHaveLength(1);
    });
  });

  describe("link() and move() compare-and-swap", () => {
    it("takes an account nobody holds, and names it only from the channel", async () => {
      const person = await repo.create({ displayName: "Alice", bondLevel: "other" });

      expect(await repo.link({ platform: "telegram", id: "tg-new" }, person)).toEqual({
        linked: true,
      });

      const rows = await testDb.db.select().from(links).where(eq(links.accountId, "tg-new"));
      expect(rows).toHaveLength(1);
      expect(rows[0].personId).toBe(person);
    });

    it("refuses an account a real person holds, and writes nothing", async () => {
      const holder = await repo.create({ displayName: "Holder", bondLevel: "other" });
      const claimant = await repo.create({ displayName: "Claimant", bondLevel: "other" });
      await repo.linkStated({ platform: "telegram", id: "tg-held" }, holder);

      const result = await repo.link({ platform: "telegram", id: "tg-held" }, claimant);

      expect(result).toEqual({
        linked: false,
        holder: {
          platform: "telegram",
          id: "tg-held",
          personId: holder,
          personName: "Holder",
        },
      });
      const rows = await testDb.db.select().from(links).where(eq(links.accountId, "tg-held"));
      expect(rows.map((row) => row.personId)).toEqual([holder]);
    });

    it("reclaims an account that was only dismissed", async () => {
      const person = await repo.create({ displayName: "Alice", bondLevel: "other" });
      await dismiss("telegram", "tg-set-aside");

      expect(await repo.link({ platform: "telegram", id: "tg-set-aside" }, person)).toEqual({
        linked: true,
      });

      const rows = await testDb.db.select().from(links).where(eq(links.accountId, "tg-set-aside"));
      expect(rows).toHaveLength(1);
      expect(rows[0].personId).toBe(person);
      expect(await repo.isDismissed({ platform: "telegram", id: "tg-set-aside" })).toBe(false);
    });

    it("lets only the first of two callers working from one view take the account", async () => {
      const holder = await repo.create({ displayName: "Holder", bondLevel: "other" });
      const first = await repo.create({ displayName: "First", bondLevel: "other" });
      const second = await repo.create({ displayName: "Second", bondLevel: "other" });
      await repo.linkStated({ platform: "telegram", id: "tg-contested" }, holder);

      // Both read the same page, so both name the same owner to swap out. The
      // check and the move are one transaction, so the second reads an owner
      // that is no longer the one it expects instead of overwriting a transfer
      // it never saw.
      const won = await repo.move({ platform: "telegram", id: "tg-contested" }, holder, first);
      const lost = await repo.move({ platform: "telegram", id: "tg-contested" }, holder, second);

      expect(won).toEqual({ linked: true });
      expect(lost).toEqual({
        linked: false,
        holder: {
          platform: "telegram",
          id: "tg-contested",
          personId: first,
          personName: "First",
        },
      });
      const rows = await testDb.db.select().from(links).where(eq(links.accountId, "tg-contested"));
      expect(rows.map((row) => row.personId)).toEqual([first]);
    });

    it("unlink() drops one link and leaves the person's others", async () => {
      const person = await repo.create({ displayName: "Alice", bondLevel: "other" });
      await repo.linkStated({ platform: "telegram", id: "tg-one" }, person);
      await repo.linkStated({ platform: "whatsapp", id: "wa-one" }, person);

      expect(await repo.unlink({ platform: "telegram", id: "tg-one" }, person)).toBe(true);
      // A link nobody holds, and one held by somebody else, are both nothing
      // for this person to drop.
      expect(await repo.unlink({ platform: "telegram", id: "tg-one" }, person)).toBe(false);

      const rows = await testDb.db.select().from(links).where(eq(links.personId, person));
      expect(rows.map((row) => row.accountId)).toEqual(["wa-one"]);
    });
  });

  describe("dismiss() and restore()", () => {
    it("dismisses an account nobody holds and restores it to a stranger", async () => {
      const account = { platform: "telegram", id: "tg-bob" };

      expect(await repo.dismiss(account)).toEqual({ linked: true });
      // Who is this answers nobody for a dismissed account, as for a stranger.
      expect(await repo.byAccount(account)).toBeNull();
      expect(await repo.isDismissed(account)).toBe(true);
      expect((await repo.dismissals()).map((d) => d.id)).toEqual(["tg-bob"]);
      // Again is the same request twice.
      expect(await repo.dismiss(account)).toEqual({ linked: true });

      expect(await repo.restore("telegram", ["tg-bob"])).toBe(1);
      expect(await repo.isDismissed(account)).toBe(false);
    });

    it("refuses to dismiss an account a person holds, and names them", async () => {
      const account = { platform: "telegram", id: "tg-alice" };
      const alice = await repo.create({
        displayName: "Alice",
        bondLevel: "other",
        links: [account],
      });

      const result = await repo.dismiss(account);

      expect(result).toEqual({
        linked: false,
        holder: { ...account, personId: alice, personName: "Alice" },
      });
      expect((await repo.byAccount(account))?.id).toBe(alice);
    });

    it("keeps the dismissal when a stated link fails, and drops it when one lands", async () => {
      const account = { platform: "telegram", id: "tg-bob" };
      await dismiss("telegram", "tg-bob");

      // No such person: the link fails, and the dismissal must not go with it.
      expect(() => repo.linkStated(account, "nobody")).toThrow();
      expect(await repo.isDismissed(account)).toBe(true);

      const bob = await repo.create({ displayName: "Bob", bondLevel: "other" });
      repo.linkStated(account, bob);

      expect(await repo.isDismissed(account)).toBe(false);
      expect((await repo.byAccount(account))?.id).toBe(bob);
    });

    it("restores only dismissals, never an address a person holds", async () => {
      const alice = await repo.create({
        displayName: "Alice",
        bondLevel: "other",
        links: [{ platform: "telegram", id: "tg-alice" }],
      });
      await repo.dismiss({ platform: "telegram", id: "tg-alias" });

      expect(await repo.restore("telegram", ["tg-alice", "tg-alias"])).toBe(1);
      expect((await repo.byId(alice))!.links).toEqual([{ platform: "telegram", id: "tg-alice" }]);
    });
  });

  describe("linkDelegate()", () => {
    it("marks the link a delegate, and the mark rides along when the guardian moves it", async () => {
      const agent = { platform: "agents", id: "agt-atlas" };
      const owner = await repo.create({ displayName: "Owner", bondLevel: "guardian" });
      const alice = await repo.create({ displayName: "Alice", bondLevel: "other" });

      await repo.linkDelegate(agent, owner);

      expect((await repo.byAccount(agent))!.links).toEqual([{ ...agent, delegate: true }]);
      // Still an agent's account, whoever the guardian says is behind it.
      expect(await repo.move(agent, owner, alice)).toEqual({ linked: true });
      expect((await repo.byId(alice))!.links).toEqual([{ ...agent, delegate: true }]);
    });

    it("is never cleared by a platform's statement about the same account", async () => {
      const agent = { platform: "agents", id: "agt-atlas" };
      const owner = await repo.create({ displayName: "Owner", bondLevel: "guardian" });
      await repo.linkDelegate(agent, owner);

      repo.linkStated(agent, owner);

      expect((await repo.byId(owner))!.links).toEqual([{ ...agent, delegate: true }]);
    });

    it("leaves a link the guardian makes by hand unmarked", async () => {
      const agent = { platform: "agents", id: "agt-friend" };
      const alice = await repo.create({ displayName: "Alice", bondLevel: "other" });

      await repo.link(agent, alice);

      expect((await repo.byId(alice))!.links).toEqual([agent]);
    });
  });

  describe("delete()", () => {
    it("deletes a person and returns their accounts to strangers", async () => {
      const tg = { platform: "telegram", id: "tg-alice" };
      const wa = { platform: "whatsapp", id: "wa-alice" };
      const alice = await repo.create({
        displayName: "Alice",
        bondLevel: "other",
        links: [tg, wa],
      });
      const bob = await repo.create({
        displayName: "Bob",
        bondLevel: "other",
        links: [{ platform: "telegram", id: "tg-bob" }],
      });

      expect(await repo.delete(alice)).toEqual({ deleted: true, links: 2 });

      expect(await repo.byId(alice)).toBeNull();
      expect(await repo.byAccount(tg)).toBeNull();
      // A stranger, not a dismissal: the guardian deleted a person, not a
      // decision about each of their accounts.
      expect(await repo.isDismissed(tg)).toBe(false);
      // An account a stranger again can be linked again.
      expect(await repo.link(wa, bob)).toEqual({ linked: true });
      expect((await repo.byId(bob))!.links).toHaveLength(2);
    });

    it("refuses the guardian and an id that names nobody", async () => {
      const guardian = await repo.create({
        displayName: "Ouou",
        bondLevel: "guardian",
        links: [{ platform: "telegram", id: "tg-ouou" }],
      });

      expect(await repo.delete(guardian)).toEqual({ deleted: false, reason: "guardian" });
      expect((await repo.byId(guardian))!.links).toHaveLength(1);
      expect(await repo.delete("nobody")).toEqual({ deleted: false, reason: "unknown" });
    });
  });

  describe("create() claiming accounts", () => {
    it("takes an account that was only dismissed", async () => {
      await dismiss("whatsapp", "+15551234");

      const bob = await repo.create({
        displayName: "Bob",
        bondLevel: "inner-circle",
        links: [{ platform: "whatsapp", id: "+15551234" }],
      });

      expect((await repo.byAccount({ platform: "whatsapp", id: "+15551234" }))?.id).toBe(bob);
      expect(await repo.isDismissed({ platform: "whatsapp", id: "+15551234" })).toBe(false);
    });

    it("refuses an account a real person holds instead of stealing it", async () => {
      const alice = await repo.create({
        displayName: "Alice",
        bondLevel: "inner-circle",
        links: [{ platform: "whatsapp", id: "+15551234" }],
      });

      await expect(
        repo.create({
          displayName: "Bob",
          bondLevel: "inner-circle",
          links: [{ platform: "whatsapp", id: "+15551234" }],
        }),
      ).rejects.toThrow(/already belongs to person "alice"/);

      expect((await repo.byAccount({ platform: "whatsapp", id: "+15551234" }))?.id).toBe(alice);
    });

    it("names the person holding the account it refused", async () => {
      const alice = await repo.create({
        displayName: "Alice Marsh",
        bondLevel: "inner-circle",
        links: [{ platform: "whatsapp", id: "+15551234" }],
      });

      // The holder's own name, not the channel-side one the mapping carries: a
      // caller reporting the conflict has to say whose account it is, and the
      // guardian knows the person by the name they gave them.
      const refused = await repo
        .create({
          displayName: "Bob",
          bondLevel: "inner-circle",
          links: [
            { platform: "telegram", id: "tg-bob" },
            { platform: "whatsapp", id: "+15551234" },
          ],
        })
        .catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(AccountHeldError);
      expect((refused as AccountHeldError).holder).toEqual({
        platform: "whatsapp",
        id: "+15551234",
        personId: alice,
        personName: "Alice Marsh",
      });
      // The unheld account in the same request is still unheld.
      expect(await repo.byAccount({ platform: "telegram", id: "tg-bob" })).toBeNull();
    });

    it("leaves no half-made person behind when a claim is refused", async () => {
      await repo.create({
        displayName: "Alice",
        bondLevel: "inner-circle",
        links: [{ platform: "whatsapp", id: "+15551234" }],
      });

      await expect(
        repo.create({
          displayName: "Bob",
          bondLevel: "inner-circle",
          links: [{ platform: "whatsapp", id: "+15551234" }],
        }),
      ).rejects.toThrow();

      // A committed Bob would be unreachable and would block every retry, since
      // callers guard on display-name uniqueness before creating.
      expect(await repo.byName("Bob")).toHaveLength(0);
      const retried = await repo.create({
        displayName: "Bob",
        bondLevel: "inner-circle",
        links: [{ platform: "whatsapp", id: "+15557777" }],
      });
      expect((await repo.byId(retried))!.displayName).toBe("Bob");
    });
  });
});
