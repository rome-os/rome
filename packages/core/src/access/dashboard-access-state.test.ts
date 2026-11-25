import { describe, expect, it } from "@rstest/core";
import { guardianAuth } from "../db/schema.js";
import { createTestDb } from "../test/db.js";
import { backfillMembers } from "./application/backfill-members.js";
import {
  guardianSeatCreated,
  guardianSeatRebound,
  inviteMember,
  memberContext,
  seatAccounts,
} from "./application/members.js";
import { placeAudience } from "../core/place-audience.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import type { DrizzleDb } from "../db/index.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "./dashboard-access-config.js";
import { DashboardAccessState } from "./dashboard-access-state.js";
import { DashboardAccessStore } from "./dashboard-access-store.js";
import { createCloudGuardian } from "./guardian-auth-state.js";

describe("DashboardAccessState", () => {
  it("starts empty", () => {
    const state = new DashboardAccessState();
    expect(state.cloudEmails().size).toBe(0);
    expect(state.hasCloudEmailAccess()).toBe(false);
    expect(state.hasSignInEmails()).toBe(false);
  });

  it("stores normalized cloud-email allow-lists", () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["Ada@Example.com", "bad email", "lin@example.com"]);
    expect([...state.cloudEmails()].sort()).toEqual(["ada@example.com", "lin@example.com"]);
    expect(state.hasCloudEmailAccess()).toBe(true);
    expect(state.hasSignInEmails()).toBe(true);
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
      await createCloudGuardian(testDb.db, "acct-owner", "owner@example.com");
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
      await createCloudGuardian(testDb.db, "acct-owner", "owner@example.com");
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
      expect(state.hasSignInEmails()).toBe(true);
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
      await createCloudGuardian(testDb.db, "acct-owner", "old@example.com");
      await guardianSeatCreated(ctx, { accounts: seatAccounts({ email: "old@example.com" }) });
      const state = new DashboardAccessState();
      await state.load(testDb.db);
      expect(state.isCloudEmailAllowed("old@example.com")).toBe(true);

      testDb.db.update(guardianAuth).set({ email: "new@example.com" }).run();
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

  it("lets in only the seat's email when the guardian's person still holds an older one", async () => {
    const testDb = createTestDb();
    try {
      const { db } = testDb;
      await createCloudGuardian(db, "acct-owner", "a@example.com");
      await backfillMembers(db);
      // The seat moved to B while its step beside the write failed, so the
      // next backfill gives the guardian's person B and leaves it A.
      db.update(guardianAuth).set({ email: "b@example.com" }).run();
      await backfillMembers(db);
      const holderOfA = await memberContext(db).identity.personOf({
        platform: "rome-cloud-email",
        accountId: "a@example.com",
      });
      expect(holderOfA).not.toBeNull();

      const state = new DashboardAccessState();
      await state.load(db);
      expect(state.isCloudEmailAllowed("a@example.com")).toBe(false);
      expect(state.isCloudEmailAllowed("b@example.com")).toBe(true);

      // A restart runs the backfill, then loads a fresh copy.
      await backfillMembers(db);
      const restarted = new DashboardAccessState();
      await restarted.load(db);
      expect(restarted.isCloudEmailAllowed("a@example.com")).toBe(false);
      expect(restarted.isCloudEmailAllowed("B@Example.com")).toBe(true);
      expect(restarted.hasCloudEmailAccess()).toBe(false);
      expect(restarted.cloudEmails().size).toBe(0);
    } finally {
      testDb.close();
    }
  });

  describe("after an older build saved a list the members do not hold", () => {
    // This build invites ada and lin. An older build after a rollback removes
    // ada, but its own update of the members fails, so ada stays a member.
    async function olderBuildRemovedAda(db: DrizzleDb): Promise<DashboardAccessStore> {
      await createCloudGuardian(db, "acct-owner", "owner@example.com");
      await backfillMembers(db);
      const settingsRepo = new SettingsRepository(db);
      const store = new DashboardAccessStore(settingsRepo, db);
      const saved = await store.save({ cloudEmailAccess: ["ada@example.com", "lin@example.com"] });
      await settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
        cloudEmailAccess: ["lin@example.com"],
        revision: saved.revision + 1,
      });
      return store;
    }

    it("lets in only the guardian's seat while the startup import has not read the list", async () => {
      const testDb = createTestDb();
      try {
        const store = await olderBuildRemovedAda(testDb.db);
        // The startup import failed, so it read nothing.
        const state = new DashboardAccessState();
        await state.load(testDb.db);

        expect(state.isCloudEmailAllowed("ada@example.com")).toBe(false);
        expect(state.isCloudEmailAllowed("lin@example.com")).toBe(false);
        expect(state.isCloudEmailAllowed("owner@example.com")).toBe(true);
        expect(state.hasCloudEmailAccess()).toBe(false);
        expect(state.cloudEmails().size).toBe(0);
        expect(state.hasSignInEmails()).toBe(true);
        expect(store.membersAreSource()).toBe(false);
        // The settings page shows the list the older build saved last.
        expect(await store.shownEmails()).toEqual(["lin@example.com"]);
      } finally {
        testDb.close();
      }
    });

    it("lets members in once the startup import reads the list", async () => {
      const testDb = createTestDb();
      try {
        const store = await olderBuildRemovedAda(testDb.db);
        await backfillMembers(testDb.db);
        const state = new DashboardAccessState();
        await state.load(testDb.db);

        expect(state.isCloudEmailAllowed("ada@example.com")).toBe(false);
        expect(state.isCloudEmailAllowed("lin@example.com")).toBe(true);
        expect(state.isCloudEmailAllowed("owner@example.com")).toBe(true);
        expect(store.membersAreSource()).toBe(true);
      } finally {
        testDb.close();
      }
    });

    it("lets the saved members in after a save on the settings page", async () => {
      const testDb = createTestDb();
      try {
        const store = await olderBuildRemovedAda(testDb.db);
        const state = new DashboardAccessState();
        await state.load(testDb.db);
        expect(state.isCloudEmailAllowed("lin@example.com")).toBe(false);

        await store.save({ cloudEmailAccess: ["lin@example.com", "kim@example.com"] });
        await state.load(testDb.db);

        expect([...state.cloudEmails()].sort()).toEqual(["kim@example.com", "lin@example.com"]);
        expect(state.isCloudEmailAllowed("ada@example.com")).toBe(false);
        expect(state.isCloudEmailAllowed("lin@example.com")).toBe(true);
        expect(store.membersAreSource()).toBe(true);
      } finally {
        testDb.close();
      }
    });
  });
});
