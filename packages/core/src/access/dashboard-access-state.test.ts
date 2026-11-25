import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/db.js";
import {
  guardianSeatCreated,
  guardianSeatRebound,
  inviteMember,
  memberContext,
  seatAccounts,
} from "./application/members.js";
import { DashboardAccessState } from "./dashboard-access-state.js";

describe("DashboardAccessState", () => {
  it("starts empty", () => {
    const state = new DashboardAccessState();
    expect(state.cloudEmails().size).toBe(0);
    expect(state.hasCloudEmailAccess()).toBe(false);
  });

  it("stores normalized cloud-email allow-lists", () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["Ada@Example.com", "bad email", "lin@example.com"]);
    expect([...state.cloudEmails()].sort()).toEqual(["ada@example.com", "lin@example.com"]);
    expect(state.hasCloudEmailAccess()).toBe(true);
    expect(state.isCloudEmailAllowed("ADA@example.com")).toBe(true);
    expect(state.isCloudEmailAllowed("grace@example.com")).toBe(false);
  });

  it("returns a Set whose mutations are isolated from later updates", () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const snapshot = state.cloudEmails();
    state.setCloudEmailAccess(["lin@example.com"]);
    expect([...snapshot]).toEqual(["ada@example.com"]);
  });

  it("loads the sign-in emails of every person with a role, the guardian's included", async () => {
    const testDb = createTestDb();
    try {
      const ctx = memberContext(testDb.db);
      await guardianSeatCreated(ctx, {
        accounts: [{ platform: "rome-cloud-email", accountId: "owner@example.com" }],
      });
      await inviteMember(ctx, "Lin@Example.com");
      await inviteMember(ctx, "ada@example.com");
      await inviteMember(ctx, "owner@example.com");
      const state = new DashboardAccessState();

      await state.load(testDb.db);

      expect([...state.cloudEmails()]).toEqual([
        "ada@example.com",
        "lin@example.com",
        "owner@example.com",
      ]);
      expect(state.isCloudEmailAllowed("Owner@Example.com")).toBe(true);
    } finally {
      testDb.close();
    }
  });

  it("lets in the rebound seat's email and no longer the old one", async () => {
    const testDb = createTestDb();
    try {
      const ctx = memberContext(testDb.db);
      await guardianSeatCreated(ctx, { accounts: seatAccounts({ email: "old@example.com" }) });
      const state = new DashboardAccessState();
      await state.load(testDb.db);
      expect(state.isCloudEmailAllowed("old@example.com")).toBe(true);

      await guardianSeatRebound(ctx, {
        previous: seatAccounts({ email: "old@example.com" }),
        current: seatAccounts({ email: "new@example.com" }),
      });
      await state.load(testDb.db);

      expect(state.isCloudEmailAllowed("new@example.com")).toBe(true);
      expect(state.isCloudEmailAllowed("old@example.com")).toBe(false);
    } finally {
      testDb.close();
    }
  });
});
