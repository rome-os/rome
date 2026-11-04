import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { ConciergeFollowItemsRepository, type FollowItemInput } from "./concierge-follow-items.js";

const item = (eventId: string, decision: FollowItemInput["decision"]): FollowItemInput => ({
  eventId,
  source: "github",
  kind: "your_ci_failed",
  target: "acme/widgets",
  decision,
  reason: "their run broke",
  line: `CI failed (${eventId})`,
  url: `https://github.com/acme/widgets/actions/runs/${eventId}`,
});

describe("ConciergeFollowItemsRepository", () => {
  let testDb: TestDb;
  let repo: ConciergeFollowItemsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ConciergeFollowItemsRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  it("keeps an event once, and owes each decision until it is delivered", async () => {
    const t0 = new Date(1_000);
    const added = await repo.add([item("e1", "notify"), item("e2", "digest")], t0);
    expect(added.map((row) => row.eventId)).toEqual(["e1", "e2"]);
    // A repeat of e1 is not stored again, and keeps its first decision.
    expect(
      await repo.add([item("e1", "digest"), item("e3", "notify")], new Date(2_000)),
    ).toHaveLength(1);
    expect([...(await repo.known(["e1", "e3", "e9"]))].sort()).toEqual(["e1", "e3"]);

    const notify = await repo.owed("notify");
    expect(notify.map((row) => row.eventId)).toEqual(["e1", "e3"]);
    await repo.markDelivered([notify[0]!.id], new Date(3_000));
    expect((await repo.owed("notify")).map((row) => row.eventId)).toEqual(["e3"]);
    expect((await repo.owed("digest")).map((row) => row.eventId)).toEqual(["e2"]);
  });

  it("moves owed notify items to the digest, and lists recent notify items", async () => {
    const [a, b] = await repo.add([item("a", "notify"), item("b", "notify")], new Date(10_000));
    await repo.markDelivered([a!.id], new Date(11_000));
    await repo.moveToDigest([a!.id, b!.id]);
    // A delivered one stays as it was.
    expect((await repo.owed("digest")).map((row) => row.eventId)).toEqual(["b"]);
    expect((await repo.recentNotify(new Date(9_000), 10)).map((row) => row.eventId)).toEqual(["a"]);
    expect(await repo.recentNotify(new Date(10_001), 10)).toEqual([]);
  });

  it("prunes delivered items only", async () => {
    const [a] = await repo.add([item("a", "digest"), item("b", "digest")], new Date(1_000));
    await repo.markDelivered([a!.id], new Date(2_000));
    await repo.prune(new Date(5_000));
    expect((await repo.owed("digest")).map((row) => row.eventId)).toEqual(["b"]);
    expect(await repo.known(["a"])).toEqual(new Set());
  });
});
