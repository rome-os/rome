import { describe, it, expect, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import {
  persons,
  channelMappings,
  routines,
  sessions,
  sentinelLog,
  approvals,
  settings,
  policies,
  guardianAuth,
} from "./schema.js";
import { eq } from "drizzle-orm";

describe("Database Integration", () => {
  let testDb: TestDb;

  afterEach(() => {
    testDb?.close();
  });

  it("createTestDb() creates in-memory SQLite connection", () => {
    testDb = createTestDb();
    expect(testDb.db).toBeDefined();
    expect(testDb.close).toBeInstanceOf(Function);
  });

  it("migrations run successfully on fresh database", async () => {
    testDb = createTestDb();

    expect(await testDb.db.select().from(routines)).toEqual([]);
    expect(await testDb.db.select().from(sessions)).toEqual([]);
    expect(await testDb.db.select().from(persons)).toEqual([]);
    expect(await testDb.db.select().from(channelMappings)).toEqual([]);
    expect(await testDb.db.select().from(sentinelLog)).toEqual([]);
    expect(await testDb.db.select().from(approvals)).toEqual([]);
    expect(await testDb.db.select().from(settings)).toEqual([]);
    expect(await testDb.db.select().from(policies)).toEqual([]);
    expect(await testDb.db.select().from(guardianAuth)).toEqual([]);
  });

  it("all tables are created with correct columns", async () => {
    testDb = createTestDb();

    await testDb.db.insert(persons).values({
      id: "p1",
      displayName: "Alice",
      bondLevel: "guardian",
      profilePath: "/profiles/alice",
      approved: true,
      createdAt: new Date("2026-01-01"),
    });

    const [person] = await testDb.db.select().from(persons).where(eq(persons.id, "p1"));

    expect(person).toMatchObject({
      id: "p1",
      displayName: "Alice",
      bondLevel: "guardian",
      profilePath: "/profiles/alice",
      approved: true,
    });
    expect(person.createdAt).toBeInstanceOf(Date);

    await testDb.db.insert(sessions).values({
      id: "s1",
      agentName: "main",
      channelThreadKey: "telegram:thread-1",
      createdAt: new Date(),
      lastActiveAt: new Date(),
      status: "active",
    });

    const [session] = await testDb.db.select().from(sessions).where(eq(sessions.id, "s1"));

    expect(session).toMatchObject({
      id: "s1",
      agentName: "main",
      channelThreadKey: "telegram:thread-1",
      status: "active",
    });
  });

  it("foreign key constraints are enforced (channelMappings → persons)", async () => {
    testDb = createTestDb();

    // Inserting a channel mapping without a valid person should fail
    await expect(
      testDb.db.insert(channelMappings).values({
        id: "cm-1",
        personId: "nonexistent-person",
        channel: "telegram",
        channelUserId: "user-123",
      }),
    ).rejects.toThrow();
  });

  it("JSON columns serialize/deserialize correctly", async () => {
    testDb = createTestDb();

    const argsData = { channel: "general", message: "hello" };
    const triggerData = { type: "schedule", tzid: "UTC", localTime: "09:00" };
    await testDb.db.insert(routines).values({
      id: "rt-json",
      name: "json-test",
      enabled: true,
      trigger: triggerData,
      actionName: "test",
      args: argsData,
      createdAt: new Date(),
    });

    const [routine] = await testDb.db.select().from(routines).where(eq(routines.id, "rt-json"));

    expect(routine.args).toEqual(argsData);
    expect(routine.trigger).toEqual(triggerData);

    // Also test settings JSON
    await testDb.db.insert(settings).values({
      key: "test-setting",
      value: { nested: { data: [1, 2, 3] } },
      updatedAt: new Date(),
    });

    const [setting] = await testDb.db
      .select()
      .from(settings)
      .where(eq(settings.key, "test-setting"));

    expect(setting.value).toEqual({ nested: { data: [1, 2, 3] } });
  });
});
