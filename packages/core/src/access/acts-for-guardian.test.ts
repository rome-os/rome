import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import {
  actsForGuardian,
  startedActingForGuardian,
  stoppedActingForGuardian,
} from "./acts-for-guardian.js";

const DOT = { platform: "agents", id: "ep-atlas" };

describe("acting for the guardian", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  it("holds from when it starts until it stops, for that account only", () => {
    expect(actsForGuardian(testDb.db, DOT)).toBe(false);

    startedActingForGuardian(testDb.db, DOT);
    startedActingForGuardian(testDb.db, DOT);
    expect(actsForGuardian(testDb.db, DOT)).toBe(true);
    expect(actsForGuardian(testDb.db, { platform: "slack", id: DOT.id })).toBe(false);

    stoppedActingForGuardian(testDb.db, DOT);
    expect(actsForGuardian(testDb.db, DOT)).toBe(false);
    stoppedActingForGuardian(testDb.db, DOT);
  });
});
