import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { AppKeysRepository } from "./app-keys.js";

describe("AppKeysRepository", () => {
  let testDb: TestDb;
  let repo: AppKeysRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new AppKeysRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("upserts and reads back a key", async () => {
    await repo.upsert({ name: "MY_KEY", label: "My key", value: "secret" });
    const row = await repo.get("MY_KEY");
    expect(row?.label).toBe("My key");
    expect(row?.value).toBe("secret");
  });

  it("replaces label and value on conflict", async () => {
    await repo.upsert({ name: "MY_KEY", label: "Old", value: "v1" });
    await repo.upsert({ name: "MY_KEY", label: "New", value: "v2" });
    const row = await repo.get("MY_KEY");
    expect(row?.label).toBe("New");
    expect(row?.value).toBe("v2");
    expect(await repo.list()).toHaveLength(1);
  });

  it("lists summaries without values, sorted by name", async () => {
    await repo.upsert({ name: "B_KEY", label: "b", value: "vb" });
    await repo.upsert({ name: "A_KEY", label: "a", value: "va" });
    const summaries = await repo.list();
    expect(summaries.map((s) => s.name)).toEqual(["A_KEY", "B_KEY"]);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("value");
    }
  });

  it("deletes a key", async () => {
    await repo.upsert({ name: "MY_KEY", label: "My key", value: "secret" });
    await repo.delete("MY_KEY");
    expect(await repo.get("MY_KEY")).toBeNull();
    expect(await repo.list()).toHaveLength(0);
  });
});
