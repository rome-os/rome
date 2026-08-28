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

describe("Person Mapping + Approval Flow (Integration)", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
    rs.restoreAllMocks();
  });

  it("add person → pending approval → approve → person.approved=true", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    // Verify pending approval exists
    const approvalRepo = new ApprovalsRepository(testDb.db);
    const approval = await approvalRepo.findById(result.approvalId);
    expect(approval).not.toBeNull();
    expect(approval!.status).toBe("pending");

    // Approve it
    await approvalRepo.approve(result.approvalId);

    // Verify approval is now approved
    const updatedApproval = await approvalRepo.findById(result.approvalId);
    expect(updatedApproval!.status).toBe("approved");

    // In the real system, an approval handler would update the person.
    // Simulate that by updating the person directly.
    const personRepo = new PersonMappingRepository(testDb.db);
    // We can update approved via raw DB since PersonMappingRepository doesn't have an update method
    const { persons } = await import("../../../../../packages/core/src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await testDb.db.update(persons).set({ approved: true }).where(eq(persons.id, result.personId));

    const person = await personRepo.findById(result.personId);
    expect(person!.approved).toBe(true);
  });

  it("add person → reject → person stays approved=false", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    const approvalRepo = new ApprovalsRepository(testDb.db);
    await approvalRepo.reject(result.approvalId);

    const updatedApproval = await approvalRepo.findById(result.approvalId);
    expect(updatedApproval!.status).toBe("rejected");

    // Person should remain unapproved
    const personRepo = new PersonMappingRepository(testDb.db);
    const person = await personRepo.findById(result.personId);
    expect(person!.approved).toBe(false);
  });

  it("add duplicate display name triggers disambiguation flow", async () => {
    // Add first person
    await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    // Try to add another with the same display name — should throw
    await expect(
      addPersonMapping(
        {
          ...baseInput,
          channelUserId: "alice-456",
        },
        {
          personMappingRepo: new PersonMappingRepository(testDb.db),
          approvalsRepo: new ApprovalsRepository(testDb.db),
        },
      ),
    ).rejects.toThrow('Person with display name "Alice" already exists');

    // Use a disambiguated name instead
    const result = await addPersonMapping(
      {
        ...baseInput,
        displayName: "Alice (work)",
        channelUserId: "alice-456",
      },
      {
        personMappingRepo: new PersonMappingRepository(testDb.db),
        approvalsRepo: new ApprovalsRepository(testDb.db),
      },
    );

    const personRepo = new PersonMappingRepository(testDb.db);
    const person = await personRepo.findById(result.personId);
    expect(person!.displayName).toBe("Alice (work)");
  });

  it("add second channel mapping for existing person uses same personId", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    // Add a second channel mapping to the existing person
    const personRepo = new PersonMappingRepository(testDb.db);
    await personRepo.addChannelMapping(result.personId, "whatsapp", "alice-whatsapp");

    const person = await personRepo.findById(result.personId);
    expect(person!.channelMappings).toHaveLength(2);
    expect(person!.channelMappings).toEqual(
      expect.arrayContaining([
        { channel: "telegram", channelUserId: "alice-123" },
        { channel: "whatsapp", channelUserId: "alice-whatsapp" },
      ]),
    );

    // Both mappings reference the same personId
    const foundViaTelegram = await personRepo.findByChannelUser("telegram", "alice-123");
    const foundViaWhatsapp = await personRepo.findByChannelUser("whatsapp", "alice-whatsapp");

    expect(foundViaTelegram!.id).toBe(result.personId);
    expect(foundViaWhatsapp!.id).toBe(result.personId);
  });

  it("findByChannelUser returns correct person after approval", async () => {
    const result = await addPersonMapping(baseInput, {
      personMappingRepo: new PersonMappingRepository(testDb.db),
      approvalsRepo: new ApprovalsRepository(testDb.db),
    });

    // Approve the person
    const { persons } = await import("../../../../../packages/core/src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await testDb.db.update(persons).set({ approved: true }).where(eq(persons.id, result.personId));

    // Look up by channel user
    const personRepo = new PersonMappingRepository(testDb.db);
    const found = await personRepo.findByChannelUser("telegram", "alice-123");

    expect(found).not.toBeNull();
    expect(found!.id).toBe(result.personId);
    expect(found!.displayName).toBe("Alice");
    expect(found!.bondLevel).toBe("inner-circle");
    expect(found!.approved).toBe(true);
    expect(found!.channelMappings).toEqual([{ channel: "telegram", channelUserId: "alice-123" }]);
  });
});
