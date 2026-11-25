import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/db.js";
import {
  guardianSeatCreated,
  guardianSeatRebound,
  inviteMember,
  memberContext,
  seatAccounts,
} from "./application/members.js";
import { placeAudience } from "../core/place-audience.js";
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

  it("loads the members' emails as the list and lets in the guardian's too", async () => {
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

      expect([...state.cloudEmails()]).toEqual(["ada@example.com", "lin@example.com"]);
      expect(state.isCloudEmailAllowed("Owner@Example.com")).toBe(true);
      expect(state.isCloudEmailAllowed("lin@example.com")).toBe(true);
    } finally {
      testDb.close();
    }
  });

  it("reads a Rome with a Rome Cloud guardian and no members as having no one invited, so the guardian's chats stay private", async () => {
    const testDb = createTestDb();
    try {
      await guardianSeatCreated(memberContext(testDb.db), {
        accounts: seatAccounts({ email: "owner@example.com" }),
      });
      const state = new DashboardAccessState();
      await state.load(testDb.db);
      // Wired as index.ts wires it.
      const audience = placeAudience({
        dashboardChat: async (id) => ({ id, agentName: "main", ownerKey: null }),
        visitorsAllowed: () => state.hasCloudEmailAccess(),
      });

      expect(state.hasCloudEmailAccess()).toBe(false);
      expect(state.cloudEmails().size).toBe(0);
      expect(state.isCloudEmailAllowed("owner@example.com")).toBe(true);
      expect(
        await audience({
          channel: "telegram",
          threadId: "1",
          threadType: "private",
          senderBondLevel: "guardian",
        }),
      ).toBe("private");
      expect(await audience({ channel: "webchat", threadId: "chat-1" })).toBe("private");
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
