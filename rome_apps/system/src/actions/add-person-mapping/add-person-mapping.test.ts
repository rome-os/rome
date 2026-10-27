import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import {
  createTestDb,
  type TestDb,
  identityConnectionKindOf,
} from "../../../../../packages/core/src/test/helpers.js";
import { PeopleRepository } from "../../../../../packages/core/src/db/repositories/people.js";
import { appPersonMapping } from "../../../../../packages/core/src/people/app-person-mapping.js";
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
      personMappingRepo: appPersonMapping(new PeopleRepository(testDb.db)),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    const personRepo = new PeopleRepository(testDb.db);
    const person = await personRepo.byId(result.personId);
    expect(person).not.toBeNull();
    expect(person!.displayName).toBe("Alice");
    expect(person!.bondLevel).toBe("inner-circle");
    expect(person!.approved).toBe(false);
  });

  it("creates channel mapping", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: appPersonMapping(new PeopleRepository(testDb.db)),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    const personRepo = new PeopleRepository(testDb.db);
    const person = await personRepo.byId(result.personId);
    expect(person).not.toBeNull();
    expect(person!.links).toHaveLength(1);
    expect(person!.links[0]).toEqual({
      platform: "telegram",
      id: "alice-123",
    });
  });

  it("creates approval request", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: appPersonMapping(new PeopleRepository(testDb.db)),
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
      personMappingRepo: appPersonMapping(new PeopleRepository(testDb.db)),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    // Trying to add the same display name should throw
    await expect(
      addPersonMapping(
        { ...baseInput, channelUserId: "alice-456" },
        {
          personMappingRepo: appPersonMapping(new PeopleRepository(testDb.db)),
          approvalsRepo: new ApprovalsRepository(testDb.db),
        },
      ),
    ).rejects.toThrow('Person with display name "Alice" already exists');
  });

  it("handles merging channel mappings for same person", async () => {
    // Create person first
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: appPersonMapping(new PeopleRepository(testDb.db)),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    // Add another channel mapping to the same person directly via repo
    const personRepo = new PeopleRepository(testDb.db);
    await personRepo.linkStated({ platform: "whatsapp", id: "alice-whatsapp" }, result.personId);

    // Verify person now has two mappings
    const person = await personRepo.byId(result.personId);
    expect(person!.links).toHaveLength(2);
    expect(person!.links).toEqual(
      expect.arrayContaining([
        { platform: "telegram", id: "alice-123" },
        { platform: "whatsapp", id: "alice-whatsapp" },
      ]),
    );
  });

  it("returns personId and approvalId", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: appPersonMapping(new PeopleRepository(testDb.db)),
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
