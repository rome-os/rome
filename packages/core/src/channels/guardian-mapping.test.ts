import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import {
  applyGuardianMappingWithinTx,
  mapGuardianToChannel,
  planGuardianMapping,
} from "./guardian-mapping.js";

describe("guardian channel mapping", () => {
  let testDb: TestDb;
  let repo: PersonMappingRepository;

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new PersonMappingRepository(testDb.db);
    await repo.createWithId("guardian", { displayName: "Guardian", bondLevel: "guardian" });
  });

  afterEach(() => {
    rs.restoreAllMocks();
    testDb.close();
  });

  /** The guardian's accounts on `channel`, sorted so the assertion is order-free. */
  async function accounts(channel: string): Promise<string[]> {
    const guardian = await repo.findById("guardian");
    return guardian!.channelMappings
      .filter((m) => m.channel === channel)
      .map((m) => m.channelUserId)
      .sort();
  }

  it("re-canonicalizes the guardian's only account on the channel", async () => {
    await repo.addChannelMapping("guardian", "whatsapp", "15551234567:8@s.whatsapp.net");

    expect(await mapGuardianToChannel(repo, "whatsapp", "15551234567@s.whatsapp.net")).toBe(true);
    expect(await accounts("whatsapp")).toEqual(["15551234567@s.whatsapp.net"]);
  });

  it("leaves an account on another channel alone when it re-canonicalizes", async () => {
    await repo.addChannelMapping("guardian", "whatsapp", "15551234567:8@s.whatsapp.net");
    await repo.addChannelMapping("guardian", "telegram", "tg-guardian");

    await mapGuardianToChannel(repo, "whatsapp", "15551234567@s.whatsapp.net");
    expect(await accounts("telegram")).toEqual(["tg-guardian"]);
  });

  it("adds a further account when the guardian already holds several on the channel", async () => {
    await repo.addChannelMapping("guardian", "telegram", "tg-work");
    await repo.addChannelMapping("guardian", "telegram", "tg-personal");

    expect(await mapGuardianToChannel(repo, "telegram", "tg-third")).toBe(true);
    expect(await accounts("telegram")).toEqual(["tg-personal", "tg-third", "tg-work"]);
  });

  it("plans an add when the guardian already holds several on the channel", async () => {
    await repo.addChannelMapping("guardian", "telegram", "tg-work");
    await repo.addChannelMapping("guardian", "telegram", "tg-personal");

    const plan = await planGuardianMapping(repo, "telegram", "tg-third");
    expect(plan).toEqual({ op: "add", guardianId: "guardian" });

    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "telegram", "tg-third", plan);
    });
    expect(await accounts("telegram")).toEqual(["tg-personal", "tg-third", "tg-work"]);
  });

  it("applies a planned re-point to the planned account only", async () => {
    await repo.addChannelMapping("guardian", "telegram", "tg-work");

    const plan = await planGuardianMapping(repo, "telegram", "tg-work-canonical");
    expect(plan).toEqual({ op: "update", guardianId: "guardian", from: "tg-work" });

    // A second account lands between the plan and its application: the grant
    // section the conferral holds keeps competing conferrals out, not
    // a link write.
    await repo.addChannelMapping("guardian", "telegram", "tg-personal");

    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "telegram", "tg-work-canonical", plan);
    });
    expect(await accounts("telegram")).toEqual(["tg-personal", "tg-work-canonical"]);
  });

  it("maps the incoming account when the one it would re-canonicalize is gone", async () => {
    // The guardian read reports an account the database no longer holds — the
    // window between that read and the write, where a link write runs.
    rs.spyOn(repo, "findByBondLevel").mockResolvedValue([
      { id: "guardian", channelMappings: [{ channel: "telegram", channelUserId: "tg-gone" }] },
    ] as unknown as Awaited<ReturnType<PersonMappingRepository["findByBondLevel"]>>);

    expect(await mapGuardianToChannel(repo, "telegram", "tg-new")).toBe(true);
    expect(await accounts("telegram")).toEqual(["tg-new"]);
  });

  it("writes nothing when the planned account is gone by the time it applies", async () => {
    await repo.addChannelMapping("guardian", "telegram", "tg-work");

    const plan = await planGuardianMapping(repo, "telegram", "tg-work-canonical");
    await repo.deleteChannelMapping("telegram", "tg-work");

    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "telegram", "tg-work-canonical", plan);
    });
    expect(await accounts("telegram")).toEqual([]);
  });

  it("re-points an account another writer claimed between the plan and the apply", async () => {
    const alice = await repo.create({ displayName: "Alice", bondLevel: "acquaintance" });

    const plan = await planGuardianMapping(repo, "telegram", "tg-guardian");
    expect(plan).toEqual({ op: "add", guardianId: "guardian" });

    // The grant section keeps competing conferrals out of this window, not
    // every writer.
    await repo.addChannelMapping(alice, "telegram", "tg-guardian");

    // The conferral commits rather than aborting on the claim it raced.
    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "telegram", "tg-guardian", plan);
    });

    expect(await accounts("telegram")).toEqual(["tg-guardian"]);
    expect((await repo.findByChannelUser("telegram", "tg-guardian"))!.id).toBe("guardian");
  });

  it("commits a planned re-point onto an account another writer claimed", async () => {
    await repo.addChannelMapping("guardian", "whatsapp", "15551234567:8@s.whatsapp.net");
    const alice = await repo.create({ displayName: "Alice", bondLevel: "acquaintance" });

    const plan = await planGuardianMapping(repo, "whatsapp", "15551234567@s.whatsapp.net");
    expect(plan).toEqual({
      op: "update",
      guardianId: "guardian",
      from: "15551234567:8@s.whatsapp.net",
    });

    // The canonical account is claimed in the window the plan cannot hold. The
    // conferral must not abort over it — the credential rides the same
    // transaction.
    await repo.addChannelMapping(alice, "whatsapp", "15551234567@s.whatsapp.net");

    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "whatsapp", "15551234567@s.whatsapp.net", plan);
    });

    expect(await accounts("whatsapp")).toEqual(["15551234567@s.whatsapp.net"]);
    expect((await repo.findById(alice))!.channelMappings).toEqual([]);
  });

  it("skips a channel user someone already holds", async () => {
    const alice = await repo.create({ displayName: "Alice", bondLevel: "acquaintance" });
    await repo.addChannelMapping(alice, "telegram", "tg-alice");

    expect(await mapGuardianToChannel(repo, "telegram", "tg-alice")).toBe(false);
    expect(await planGuardianMapping(repo, "telegram", "tg-alice")).toEqual({ op: "noop" });
    expect(await accounts("telegram")).toEqual([]);
  });
});
