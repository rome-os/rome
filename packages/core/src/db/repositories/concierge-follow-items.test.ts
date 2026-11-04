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
    const added = await repo.add([item("e1", "important"), item("e2", "digest")], t0);
    expect(added.map((row) => row.eventId)).toEqual(["e1", "e2"]);
    // A repeat of e1 is not stored again, and keeps its first decision.
    expect(
      await repo.add([item("e1", "digest"), item("e3", "important")], new Date(2_000)),
    ).toHaveLength(1);
    expect([...(await repo.known(["e1", "e3", "e9"]))].sort()).toEqual(["e1", "e3"]);

    const important = await repo.owed("important");
    expect(important.map((row) => row.eventId)).toEqual(["e1", "e3"]);
    await repo.markDelivered([important[0]!.id], new Date(3_000));
    expect((await repo.owed("important")).map((row) => row.eventId)).toEqual(["e3"]);
    expect((await repo.owed("digest")).map((row) => row.eventId)).toEqual(["e2"]);
  });

  it("leaves untold important items for the digest, still important, and lists recent ones", async () => {
    const [a, b] = await repo.add(
      [item("a", "important"), item("b", "important")],
      new Date(10_000),
    );
    await repo.markDelivered([a!.id], new Date(11_000));
    await repo.deferToDigest([a!.id, b!.id], new Date(11_000));
    // A delivered one stays as it was; the other is owed to the digest, not to the Concierge.
    expect(await repo.owed("important")).toEqual([]);
    expect((await repo.owed("digest")).map((row) => [row.eventId, row.decision])).toEqual([
      ["b", "important"],
    ]);
    expect((await repo.recentImportant(new Date(9_000), 10)).map((row) => row.eventId)).toEqual([
      "a",
    ]);
    expect(await repo.recentImportant(new Date(10_001), 10)).toEqual([]);
  });

  it("prunes delivered items only", async () => {
    const [a] = await repo.add([item("a", "digest"), item("b", "digest")], new Date(1_000));
    await repo.markDelivered([a!.id], new Date(2_000));
    await repo.prune(new Date(5_000));
    expect((await repo.owed("digest")).map((row) => row.eventId)).toEqual(["b"]);
    expect(await repo.known(["a"])).toEqual(new Set());
  });
});
