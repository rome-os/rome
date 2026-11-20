import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/db.js";
import { fullIdsByUniqueLocalName } from "../../apps/actions/registry.js";
import { RoutinesRepository } from "./routines.js";

const DAILY = {
  type: "schedule",
  localTime: "09:00",
  tzid: "UTC",
  tzMode: "fixed",
  rrule: "FREQ=DAILY",
} as const;

describe("routines saved under an action's old bare name", () => {
  let testDb: TestDb;
  let repo: RoutinesRepository;
  beforeEach(() => {
    testDb = createTestDb();
    repo = new RoutinesRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  it("fire by the action's full ID, and full IDs stay as they are", async () => {
    const save = (actionName: string) =>
      repo.create({ name: actionName, trigger: DAILY, actionName, args: {} });
    const bare = await save("system_upgrade");
    const full = await save("system:send_message");
    const unknown = await save("gone_action");

    const renamed = await repo.deprecatedQualifyActionNames({
      system_upgrade: "system:system_upgrade",
      send_message: "system:send_message",
    });

    expect(renamed).toBe(1);
    expect((await repo.findById(bare))?.actionName).toBe("system:system_upgrade");
    expect((await repo.findById(full))?.actionName).toBe("system:send_message");
    expect((await repo.findById(unknown))?.actionName).toBe("gone_action");
  });

  it("fire by the registered action's full ID on a profile that stored no old-name map", async () => {
    const bare = await repo.create({
      name: "upgrade",
      trigger: DAILY,
      actionName: "system_upgrade",
      args: {},
    });

    const renamed = await repo.deprecatedQualifyActionNames(
      fullIdsByUniqueLocalName(["system:system_upgrade", "system:send_message"]),
    );

    expect(renamed).toBe(1);
    expect((await repo.findById(bare))?.actionName).toBe("system:system_upgrade");
  });
});
