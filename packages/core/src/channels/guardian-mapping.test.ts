import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { createTestDb, type TestDb, identityConnectionKindOf } from "../test/helpers.js";
import { PeopleRepository } from "../db/repositories/people.js";
import {
  applyGuardianMappingWithinTx,
  mapGuardianToChannel,
  planGuardianMapping,
} from "./guardian-mapping.js";

describe("guardian channel mapping", () => {
  let testDb: TestDb;
  let repo: PeopleRepository;

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new PeopleRepository(testDb.db, identityConnectionKindOf);
    await repo.createWithId("guardian", { displayName: "Guardian", bondLevel: "guardian" });
  });

  afterEach(() => {
    rs.restoreAllMocks();
    testDb.close();
  });

  /** The guardian's accounts on `channel`, sorted so the assertion is order-free. */
  async function accounts(channel: string): Promise<string[]> {
    const guardian = await repo.byId("guardian");
    return guardian!.links
      .filter((m) => m.channel === channel)
      .map((m) => m.channelUserId)
      .sort();
  }

  it("leaves an account the guardian dismissed alone, on both paths", async () => {
    await repo.dismiss({ channel: "telegram", channelUserId: "tg-dismissed" });

    expect(await mapGuardianToChannel(repo, "telegram", "tg-dismissed")).toBe(false);
    expect(await planGuardianMapping(repo, "telegram", "tg-dismissed")).toEqual({ op: "noop" });
    expect(await accounts("telegram")).toEqual([]);
    expect(await repo.isDismissed({ channel: "telegram", channelUserId: "tg-dismissed" })).toBe(
      true,
    );
  });

  it("re-canonicalizes the guardian's only account on the channel", async () => {
    await repo.linkStated(
      { channel: "whatsapp", channelUserId: "15551234567:8@s.whatsapp.net" },
      "guardian",
    );

    expect(await mapGuardianToChannel(repo, "whatsapp", "15551234567@s.whatsapp.net")).toBe(true);
    expect(await accounts("whatsapp")).toEqual(["15551234567@s.whatsapp.net"]);
  });

  it("leaves an account on another channel alone when it re-canonicalizes", async () => {
    await repo.linkStated(
      { channel: "whatsapp", channelUserId: "15551234567:8@s.whatsapp.net" },
      "guardian",
    );
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-guardian" }, "guardian");

    await mapGuardianToChannel(repo, "whatsapp", "15551234567@s.whatsapp.net");
    expect(await accounts("telegram")).toEqual(["tg-guardian"]);
  });

  it("adds a further account when the guardian already holds several on the channel", async () => {
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-work" }, "guardian");
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-personal" }, "guardian");

    expect(await mapGuardianToChannel(repo, "telegram", "tg-third")).toBe(true);
    expect(await accounts("telegram")).toEqual(["tg-personal", "tg-third", "tg-work"]);
  });

  it("plans an add when the guardian already holds several on the channel", async () => {
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-work" }, "guardian");
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-personal" }, "guardian");

    const plan = await planGuardianMapping(repo, "telegram", "tg-third");
    expect(plan).toEqual({ op: "add", guardianId: "guardian" });

    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "telegram", "tg-third", plan);
    });
    expect(await accounts("telegram")).toEqual(["tg-personal", "tg-third", "tg-work"]);
  });

  it("applies a planned re-point to the planned account only", async () => {
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-work" }, "guardian");

    const plan = await planGuardianMapping(repo, "telegram", "tg-work-canonical");
    expect(plan).toEqual({ op: "update", guardianId: "guardian", from: "tg-work" });

    // A second account lands between the plan and its application: the grant
    // section the grant holds keeps competing grants out, not
    // a link write.
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-personal" }, "guardian");

    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "telegram", "tg-work-canonical", plan);
    });
    expect(await accounts("telegram")).toEqual(["tg-personal", "tg-work-canonical"]);
  });

  it("maps the incoming account when the one it would re-canonicalize is gone", async () => {
    // The guardian read reports an account the database no longer holds — the
    // window between that read and the write, where a link write runs.
    rs.spyOn(repo, "byBondLevel").mockResolvedValue([
      { id: "guardian", links: [{ channel: "telegram", channelUserId: "tg-gone" }] },
    ] as unknown as Awaited<ReturnType<PeopleRepository["byBondLevel"]>>);

    expect(await mapGuardianToChannel(repo, "telegram", "tg-new")).toBe(true);
    expect(await accounts("telegram")).toEqual(["tg-new"]);
  });

  it("writes nothing when the planned account is gone by the time it applies", async () => {
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-work" }, "guardian");

    const plan = await planGuardianMapping(repo, "telegram", "tg-work-canonical");
    await repo.unlink({ channel: "telegram", channelUserId: "tg-work" });

    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "telegram", "tg-work-canonical", plan);
    });
    expect(await accounts("telegram")).toEqual([]);
  });

  it("re-points an account another writer claimed between the plan and the apply", async () => {
    const alice = await repo.create({ displayName: "Alice", bondLevel: "acquaintance" });

    const plan = await planGuardianMapping(repo, "telegram", "tg-guardian");
    expect(plan).toEqual({ op: "add", guardianId: "guardian" });

    // The grant section keeps competing grants out of this window, not
    // every writer.
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-guardian" }, alice);

    // The grant commits rather than aborting on the claim it raced.
    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "telegram", "tg-guardian", plan);
    });

    expect(await accounts("telegram")).toEqual(["tg-guardian"]);
    expect((await repo.byAccount({ channel: "telegram", channelUserId: "tg-guardian" }))!.id).toBe(
      "guardian",
    );
  });

  it("commits a planned re-point onto an account another writer claimed", async () => {
    await repo.linkStated(
      { channel: "whatsapp", channelUserId: "15551234567:8@s.whatsapp.net" },
      "guardian",
    );
    const alice = await repo.create({ displayName: "Alice", bondLevel: "acquaintance" });

    const plan = await planGuardianMapping(repo, "whatsapp", "15551234567@s.whatsapp.net");
    expect(plan).toEqual({
      op: "update",
      guardianId: "guardian",
      from: "15551234567:8@s.whatsapp.net",
    });

    // The canonical account is claimed in the window the plan cannot hold. The
    // grant must not abort over it — the credential rides the same
    // transaction.
    await repo.linkStated(
      { channel: "whatsapp", channelUserId: "15551234567@s.whatsapp.net" },
      alice,
    );

    testDb.db.transaction((tx) => {
      applyGuardianMappingWithinTx(tx, repo, "whatsapp", "15551234567@s.whatsapp.net", plan);
    });

    expect(await accounts("whatsapp")).toEqual(["15551234567@s.whatsapp.net"]);
    expect((await repo.byId(alice))!.links).toEqual([]);
  });

  it("skips a channel user someone already holds", async () => {
    const alice = await repo.create({ displayName: "Alice", bondLevel: "acquaintance" });
    await repo.linkStated({ channel: "telegram", channelUserId: "tg-alice" }, alice);

    expect(await mapGuardianToChannel(repo, "telegram", "tg-alice")).toBe(false);
    expect(await planGuardianMapping(repo, "telegram", "tg-alice")).toEqual({ op: "noop" });
    expect(await accounts("telegram")).toEqual([]);
  });
});
