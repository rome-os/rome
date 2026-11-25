import { afterEach, describe, expect, it } from "@rstest/core";
import { identities, members } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { GuardianRemovalError } from "../access.js";
import {
  guardianSeatCreated,
  guardianSeatRebound,
  invitedEmailsSaved,
  inviteMember,
  listMembers,
  memberContext,
  memberSignedIn,
  removeMember,
  roleOfAccount,
  seatAccounts,
} from "./members.js";

const OWNER_EMAIL = { platform: "rome-cloud-email", accountId: "owner@example.com" };
const OWNER_SLACK = { platform: "slack", accountId: "T1:U0" };
const ADA_EMAIL = { platform: "rome-cloud-email", accountId: "ada@example.com" };
const ADA_SLACK = { platform: "slack", accountId: "T1:U2" };

describe("members", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup() {
    testDb = createTestDb();
    const ctx = memberContext(testDb.db);
    return { db: testDb.db, ctx, identity: ctx.identity, access: ctx.access };
  }

  describe("roleOfAccount", () => {
    it("answers the role of the person an account belongs to", async () => {
      const { ctx } = setup();
      await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL] });
      await inviteMember(ctx, "Ada@Example.com");

      expect(await roleOfAccount(ctx, OWNER_EMAIL)).toBe("guardian");
      expect(await roleOfAccount(ctx, ADA_EMAIL)).toBe("member");
    });

    it("answers null for an account nobody holds and for a person with no role", async () => {
      const { ctx, identity } = setup();
      await identity.createPerson({ accounts: [{ platform: "slack", accountId: "T1:U1" }] });

      expect(await roleOfAccount(ctx, { platform: "slack", accountId: "T1:U9" })).toBeNull();
      expect(await roleOfAccount(ctx, { platform: "slack", accountId: "T1:U1" })).toBeNull();
    });
  });

  describe("listMembers", () => {
    it("lists each member's person, role and accounts, the guardian first", async () => {
      const { ctx } = setup();
      const ada = await inviteMember(ctx, ADA_EMAIL.accountId);
      const owner = await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL], name: "Owner" });

      expect(await listMembers(ctx)).toEqual([
        {
          person: { id: owner.id, name: "Owner", avatarUrl: null },
          role: "guardian",
          accounts: [OWNER_EMAIL],
        },
        {
          person: { id: ada.id, name: null, avatarUrl: null },
          role: "member",
          accounts: [ADA_EMAIL],
        },
      ]);
    });
  });

  describe("guardianSeatCreated", () => {
    it("keeps one guardian, and a second call only adds the accounts they lack", async () => {
      const { db, ctx } = setup();
      const first = await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL], name: "Owner" });
      const again = await guardianSeatCreated(ctx, {
        accounts: [OWNER_EMAIL, OWNER_SLACK],
        name: "Other",
      });
      await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL, OWNER_SLACK] });

      expect(again).toEqual(first);
      expect(db.select().from(members).all()).toHaveLength(1);
      expect(db.select().from(identities).all()).toHaveLength(1);
      expect((await listMembers(ctx))[0]?.accounts).toEqual([OWNER_EMAIL, OWNER_SLACK]);
    });

    it("moves an account another person holds to the guardian", async () => {
      const { ctx } = setup();
      const ada = await inviteMember(ctx, ADA_EMAIL.accountId);
      const owner = await guardianSeatCreated(ctx, { accounts: [ADA_EMAIL] });

      expect(await roleOfAccount(ctx, ADA_EMAIL)).toBe("guardian");
      expect((await listMembers(ctx)).find((m) => m.person.id === ada.id)?.accounts).toEqual([]);
      expect(owner.id).not.toBe(ada.id);
    });

    it("gives a seat's guardian the seat's email only, and a local seat's no account", async () => {
      const { ctx } = setup();
      await guardianSeatCreated(ctx, { accounts: seatAccounts({}), name: "owner" });
      expect((await listMembers(ctx))[0]?.accounts).toEqual([]);
      await guardianSeatCreated(ctx, { accounts: seatAccounts({ email: " Owner@Example.com" }) });

      expect(await listMembers(ctx)).toEqual([
        {
          person: expect.objectContaining({ name: "owner" }),
          role: "guardian",
          accounts: [OWNER_EMAIL],
        },
      ]);
    });
  });

  describe("guardianSeatRebound", () => {
    const NEW_EMAIL = { platform: "rome-cloud-email", accountId: "new@example.com" };
    const SLACK = { platform: "slack", accountId: "T1:U1" };

    it("moves the guardian from the seat's old email to its new one, keeping the rest", async () => {
      const { ctx } = setup();
      await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL, SLACK, ADA_EMAIL] });

      const rebind = {
        previous: seatAccounts({ email: OWNER_EMAIL.accountId }),
        current: seatAccounts({ email: NEW_EMAIL.accountId }),
      };
      await guardianSeatRebound(ctx, rebind);
      await guardianSeatRebound(ctx, rebind);

      expect(await roleOfAccount(ctx, OWNER_EMAIL)).toBeNull();
      expect(await roleOfAccount(ctx, NEW_EMAIL)).toBe("guardian");
      expect((await listMembers(ctx)).map((m) => m.accounts)).toEqual([
        [ADA_EMAIL, NEW_EMAIL, SLACK],
      ]);
    });

    it("leaves an old email another person holds", async () => {
      const { ctx } = setup();
      await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL] });
      await ctx.identity.removeAccount(OWNER_EMAIL);
      const ada = await inviteMember(ctx, OWNER_EMAIL.accountId);

      await guardianSeatRebound(ctx, { previous: [OWNER_EMAIL], current: [NEW_EMAIL] });

      expect(await roleOfAccount(ctx, NEW_EMAIL)).toBe("guardian");
      expect((await ctx.identity.personOf(OWNER_EMAIL))?.id).toBe(ada.id);
    });
  });

  describe("inviteMember", () => {
    it("answers the guardian for their own email instead of adding a member", async () => {
      const { ctx, access } = setup();
      const owner = await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL] });

      expect((await inviteMember(ctx, "owner@example.com")).id).toBe(owner.id);
      expect(await access.roleOf(owner.id)).toBe("guardian");
    });

    it("makes a person who already holds the email a member without making another", async () => {
      const { db, ctx, identity, access } = setup();
      const ada = await identity.createPerson({ accounts: [ADA_EMAIL] });

      expect((await inviteMember(ctx, ADA_EMAIL.accountId)).id).toBe(ada.id);
      expect(db.select().from(identities).all()).toHaveLength(1);
      expect(await access.roleOf(ada.id)).toBe("member");
    });
  });

  describe("removeMember", () => {
    it("revokes the role, then deletes the person and frees their accounts", async () => {
      const { db, ctx, identity } = setup();
      const ada = await inviteMember(ctx, ADA_EMAIL.accountId);
      await identity.addAccount(ada.id, ADA_SLACK);

      await removeMember(ctx, "ADA@example.com");

      expect(await roleOfAccount(ctx, ADA_SLACK)).toBeNull();
      expect(await identity.personOf(ADA_EMAIL)).toBeNull();
      expect(await identity.personOf(ADA_SLACK)).toBeNull();
      expect(db.select().from(members).all()).toEqual([]);
      await identity.createPerson({ accounts: [ADA_SLACK] });
    });

    it("refuses to remove the guardian and changes nothing", async () => {
      const { ctx, access } = setup();
      const owner = await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL] });

      await expect(removeMember(ctx, OWNER_EMAIL.accountId)).rejects.toBeInstanceOf(
        GuardianRemovalError,
      );
      expect(await access.roleOf(owner.id)).toBe("guardian");
      expect(await roleOfAccount(ctx, OWNER_EMAIL)).toBe("guardian");
    });

    it("leaves a person with no role alone", async () => {
      const { ctx, identity } = setup();
      const stranger = await identity.createPerson({ accounts: [ADA_EMAIL] });

      await removeMember(ctx, ADA_EMAIL.accountId);
      await removeMember(ctx, "nobody@example.com");

      expect((await identity.personOf(ADA_EMAIL))?.id).toBe(stranger.id);
    });
  });

  describe("invitedEmailsSaved", () => {
    it("makes the members exactly the listed emails and never touches the guardian", async () => {
      const { ctx } = setup();
      await guardianSeatCreated(ctx, { accounts: [OWNER_EMAIL] });
      await invitedEmailsSaved(ctx, ["ada@example.com", "lin@example.com"]);
      await invitedEmailsSaved(ctx, ["lin@example.com", "owner@example.com"]);

      const listed = await listMembers(ctx);
      expect(listed.map((m) => [m.role, m.accounts.map((a) => a.accountId)])).toEqual([
        ["guardian", ["owner@example.com"]],
        ["member", ["lin@example.com"]],
      ]);
      expect(await roleOfAccount(ctx, ADA_EMAIL)).toBeNull();
    });
  });

  describe("memberSignedIn", () => {
    it("gives a member's person the avatar and no account, and no person to a visitor who is not one", async () => {
      const { db, ctx } = setup();
      const ada = await inviteMember(ctx, ADA_EMAIL.accountId);

      await memberSignedIn(ctx, {
        email: "Ada@example.com",
        avatarUrl: "https://example.com/ada.png",
      });
      await memberSignedIn(ctx, { email: "zed@example.com", avatarUrl: null });

      expect(await listMembers(ctx)).toEqual([
        {
          person: { id: ada.id, name: null, avatarUrl: "https://example.com/ada.png" },
          role: "member",
          accounts: [ADA_EMAIL],
        },
      ]);
      expect(db.select().from(identities).all()).toHaveLength(1);
    });

    it("knows a sign-in with the guardian's email as the guardian's person", async () => {
      const { db, ctx } = setup();
      const owner = await guardianSeatCreated(ctx, {
        accounts: seatAccounts({ email: OWNER_EMAIL.accountId }),
        avatarUrl: "https://example.com/owner.png",
      });
      await invitedEmailsSaved(ctx, [OWNER_EMAIL.accountId]);

      await memberSignedIn(ctx, {
        email: "Owner@Example.com",
        avatarUrl: "https://example.com/visitor.png",
      });

      expect(await listMembers(ctx)).toEqual([
        {
          person: { id: owner.id, name: null, avatarUrl: "https://example.com/visitor.png" },
          role: "guardian",
          accounts: [OWNER_EMAIL],
        },
      ]);
      expect(db.select().from(identities).all()).toHaveLength(1);
    });
  });
});
