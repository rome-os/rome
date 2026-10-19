import { afterEach, describe, expect, it } from "@rstest/core";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createTestDb, recordedServiceOf, type TestDb } from "../test/helpers.js";
import { isGuardianFacingChannel } from "./guardian-channel.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");

describe("isGuardianFacingChannel", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("reads a service's second channel, keyed by an opaque id, as that service", () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    records.claim(testDb.db, { id: "c1", service: "telegram" }, NOW);
    const second = records.claim(testDb.db, { id: "c2", service: "telegram" }, NOW).id;
    const serviceOf = recordedServiceOf(testDb.db);

    expect(second).not.toBe("telegram");
    expect(isGuardianFacingChannel(`${second}:42`, serviceOf)).toBe(true);
    expect(isGuardianFacingChannel("telegram:42", serviceOf)).toBe(true);
    expect(isGuardianFacingChannel("webchat:chat-1", serviceOf)).toBe(true);
    expect(isGuardianFacingChannel("slack:C1", serviceOf)).toBe(false);
  });
});
