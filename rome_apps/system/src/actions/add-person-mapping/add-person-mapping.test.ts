import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import { PersonMappingRepository } from "../../../../../packages/core/src/db/repositories/person-mapping.js";
import { ApprovalsRepository } from "../../../../../packages/core/src/db/repositories/approvals.js";
import { addPersonMapping, type AddPersonMappingInput } from "./index.js";

let testDb: TestDb;

const baseInput: AddPersonMappingInput = {
  displayName: "Alice",
  channel: "telegram",
  channelUserId: "alice-123",
  bondLevel: "inner-circle",
};

describe("addPersonMapping", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
    rs.restoreAllMocks();
  });

  it("creates person record (approved=false)", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    const personRepo = new PersonMappingRepository(testDb.db);
    const person = await personRepo.findById(result.personId);
    expect(person).not.toBeNull();
    expect(person!.displayName).toBe("Alice");
    expect(person!.bondLevel).toBe("inner-circle");
    expect(person!.approved).toBe(false);
  });

  it("creates channel mapping", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    const personRepo = new PersonMappingRepository(testDb.db);
    const person = await personRepo.findById(result.personId);
    expect(person).not.toBeNull();
    expect(person!.channelMappings).toHaveLength(1);
    expect(person!.channelMappings[0]).toEqual({
      channel: "telegram",
      channelUserId: "alice-123",
    });
  });

  it("creates approval request", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    const approvalRepo = new ApprovalsRepository(testDb.db);
    const approval = await approvalRepo.findById(result.approvalId);
    expect(approval).not.toBeNull();
    expect(approval!.type).toBe("person_mapping");
    expect(approval!.status).toBe("pending");
    expect(approval!.requestedBy).toBe("agent");
  });

  it("handles existing person with same display name", async () => {
    // Create a person first
    await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    // Trying to add the same display name should throw
    await expect(
      addPersonMapping(
        { ...baseInput, channelUserId: "alice-456" },
        {
          personMappingRepo: new PersonMappingRepository(testDb.db),
          approvalsRepo: new ApprovalsRepository(testDb.db),
        },
      ),
    ).rejects.toThrow('Person with display name "Alice" already exists');
  });

  it("handles merging channel mappings for same person", async () => {
    // Create person first
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    // Add another channel mapping to the same person directly via repo
    const personRepo = new PersonMappingRepository(testDb.db);
    await personRepo.addChannelMapping(result.personId, "whatsapp", "alice-whatsapp");

    // Verify person now has two mappings
    const person = await personRepo.findById(result.personId);
    expect(person!.channelMappings).toHaveLength(2);
    expect(person!.channelMappings).toEqual(
      expect.arrayContaining([
        { channel: "telegram", channelUserId: "alice-123" },
        { channel: "whatsapp", channelUserId: "alice-whatsapp" },
      ]),
    );
  });

  it("returns personId and approvalId", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    expect(result).toHaveProperty("personId");
    expect(result).toHaveProperty("approvalId");
    expect(typeof result.personId).toBe("string");
    expect(typeof result.approvalId).toBe("string");
    expect(result.personId.length).toBeGreaterThan(0);
    expect(result.approvalId.length).toBeGreaterThan(0);
  });
});
