import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { createTestDb, type TestDb, identityConnectionKindOf } from "../test/db.js";
import { DrizzlePeopleRepository } from "./infrastructure/drizzle-people-repository.js";
import type { PeopleRepository } from "./model/people-repository.js";
import { linkGuardianToAccount } from "./guardian-mapping.js";

describe("guardian channel mapping", () => {
  let testDb: TestDb;
  let repo: PeopleRepository;

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new DrizzlePeopleRepository(testDb.db);
    await repo.createWithId("guardian", { displayName: "Guardian", bondLevel: "guardian" });
  });

  afterEach(() => {
    rs.restoreAllMocks();
    testDb.close();
  });

  /** The guardian's accounts on `platform`, sorted so the assertion is order-free. */
  async function accounts(platform: string): Promise<string[]> {
    const guardian = await repo.byId("guardian");
    return guardian!.links
      .filter((m) => m.platform === platform)
      .map((m) => m.id)
      .sort();
  }

  it("leaves an account the guardian dismissed alone", async () => {
    await repo.dismiss({ platform: "telegram", id: "tg-dismissed" });

    expect(await linkGuardianToAccount(repo, "telegram", "tg-dismissed")).toBe(false);
    expect(await accounts("telegram")).toEqual([]);
    expect(await repo.isDismissed({ platform: "telegram", id: "tg-dismissed" })).toBe(true);
  });

  it("re-canonicalizes the guardian's only account on the channel", async () => {
    await repo.linkStated({ platform: "whatsapp", id: "15551234567:8@s.whatsapp.net" }, "guardian");

    expect(await linkGuardianToAccount(repo, "whatsapp", "15551234567@s.whatsapp.net")).toBe(true);
    expect(await accounts("whatsapp")).toEqual(["15551234567@s.whatsapp.net"]);
  });

  it("adds an account beside the guardian's only one on the channel, with addOnly", async () => {
    await linkGuardianToAccount(repo, "discord", "discord-a");
    expect(await linkGuardianToAccount(repo, "discord", "discord-b", { addOnly: true })).toBe(true);
    // Either account writing again moves neither.
    expect(await linkGuardianToAccount(repo, "discord", "discord-a", { addOnly: true })).toBe(
      false,
    );
    expect(await linkGuardianToAccount(repo, "discord", "discord-b", { addOnly: true })).toBe(
      false,
    );
    expect(await accounts("discord")).toEqual(["discord-a", "discord-b"]);
  });

  it("leaves an account on another channel alone when it re-canonicalizes", async () => {
    await repo.linkStated({ platform: "whatsapp", id: "15551234567:8@s.whatsapp.net" }, "guardian");
    await repo.linkStated({ platform: "telegram", id: "tg-guardian" }, "guardian");

    await linkGuardianToAccount(repo, "whatsapp", "15551234567@s.whatsapp.net");
    expect(await accounts("telegram")).toEqual(["tg-guardian"]);
  });

  it("adds a further account when the guardian already holds several on the channel", async () => {
    await repo.linkStated({ platform: "telegram", id: "tg-work" }, "guardian");
    await repo.linkStated({ platform: "telegram", id: "tg-personal" }, "guardian");

    expect(await linkGuardianToAccount(repo, "telegram", "tg-third")).toBe(true);
    expect(await accounts("telegram")).toEqual(["tg-personal", "tg-third", "tg-work"]);
  });

  it("maps the incoming account when the one it would re-canonicalize is gone", async () => {
    // The guardian read reports an account the database no longer holds — the
    // window between that read and the write, where a link write runs.
    rs.spyOn(repo, "byBondLevel").mockResolvedValue([
      { id: "guardian", links: [{ platform: "telegram", id: "tg-gone" }] },
    ] as unknown as Awaited<ReturnType<PeopleRepository["byBondLevel"]>>);

    expect(await linkGuardianToAccount(repo, "telegram", "tg-new")).toBe(true);
    expect(await accounts("telegram")).toEqual(["tg-new"]);
  });

  it("skips a channel user someone already holds", async () => {
    const alice = await repo.create({ displayName: "Alice", bondLevel: "acquaintance" });
    await repo.linkStated({ platform: "telegram", id: "tg-alice" }, alice);

    expect(await linkGuardianToAccount(repo, "telegram", "tg-alice")).toBe(false);
    expect(await accounts("telegram")).toEqual([]);
  });
});
