import { afterEach, describe, expect, it } from "@rstest/core";
import { identities, members } from "../../db/schema.js";
import { AccountTakenError } from "../../identity/identity.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { GuardianRemovalError } from "../access.js";
import {
  guardianSeatCreated,
  invitedEmailsSaved,
  inviteMember,
  listMembers,
  memberContext,
  memberSignedIn,
  removeMember,
  ROME_CLOUD_PLATFORM,
  roleOfAccount,
  seatAccounts,
} from "./members.js";

const OWNER_CLOUD = { platform: ROME_CLOUD_PLATFORM, accountId: "acct-owner" };
const OWNER_EMAIL = { platform: "email", accountId: "owner@example.com" };
const ADA_EMAIL = { platform: "email", accountId: "ada@example.com" };
const ADA_CLOUD = { platform: ROME_CLOUD_PLATFORM, accountId: "acct-ada" };

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
      await guardianSeatCreated(ctx, { accounts: [OWNER_CLOUD] });
      await inviteMember(ctx, "Ada@Example.com");

      expect(await roleOfAccount(ctx, OWNER_CLOUD)).toBe("guardian");
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
      const owner = await guardianSeatCreated(ctx, { accounts: [OWNER_CLOUD], name: "Owner" });

      expect(await listMembers(ctx)).toEqual([
        {
          person: { id: owner.id, name: "Owner", avatarUrl: null },
          role: "guardian",
          accounts: [OWNER_CLOUD],
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
      const first = await guardianSeatCreated(ctx, { accounts: [OWNER_CLOUD], name: "Owner" });
      const again = await guardianSeatCreated(ctx, {
        accounts: [OWNER_CLOUD, OWNER_EMAIL],
        name: "Other",
      });
      await guardianSeatCreated(ctx, { accounts: [OWNER_CLOUD, OWNER_EMAIL] });

      expect(again).toEqual(first);
      expect(db.select().from(members).all()).toHaveLength(1);
      expect(db.select().from(identities).all()).toHaveLength(1);
      expect((await listMembers(ctx))[0]?.accounts).toEqual([OWNER_EMAIL, OWNER_CLOUD]);
    });

    it("moves an account another person holds to the guardian", async () => {
      const { ctx } = setup();
      const ada = await inviteMember(ctx, ADA_EMAIL.accountId);
      const owner = await guardianSeatCreated(ctx, { accounts: [ADA_EMAIL] });

      expect(await roleOfAccount(ctx, ADA_EMAIL)).toBe("guardian");
      expect((await listMembers(ctx)).find((m) => m.person.id === ada.id)?.accounts).toEqual([]);
      expect(owner.id).not.toBe(ada.id);
    });

    it("makes a seat's guardian with the seat's accounts, and a local seat's with none", async () => {
      const { ctx } = setup();
      await guardianSeatCreated(ctx, { accounts: seatAccounts({}), name: "owner" });
      await guardianSeatCreated(ctx, {
        accounts: seatAccounts({ accountId: "acct-owner", email: " Owner@Example.com" }),
      });

      expect(await listMembers(ctx)).toEqual([
        {
          person: expect.objectContaining({ name: "owner" }),
          role: "guardian",
          accounts: [OWNER_EMAIL, OWNER_CLOUD],
        },
      ]);
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
      await inviteMember(ctx, ADA_EMAIL.accountId);
      await memberSignedIn(ctx, { email: ADA_EMAIL.accountId, account: ADA_CLOUD });

      await removeMember(ctx, "ADA@example.com");

      expect(await roleOfAccount(ctx, ADA_CLOUD)).toBeNull();
      expect(await identity.personOf(ADA_EMAIL)).toBeNull();
      expect(await identity.personOf(ADA_CLOUD)).toBeNull();
      expect(db.select().from(members).all()).toEqual([]);
      await identity.createPerson({ accounts: [ADA_CLOUD] });
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
    it("records a member's sign-in with their avatar, and no person for a visitor who is not one", async () => {
      const { db, ctx } = setup();
      const ada = await inviteMember(ctx, ADA_EMAIL.accountId);

      await memberSignedIn(ctx, {
        email: "Ada@example.com",
        account: ADA_CLOUD,
        avatarUrl: "https://example.com/ada.png",
      });
      await memberSignedIn(ctx, {
        email: "zed@example.com",
        account: { platform: ROME_CLOUD_PLATFORM, accountId: "acct-zed" },
        avatarUrl: null,
      });

      expect(await listMembers(ctx)).toEqual([
        {
          person: { id: ada.id, name: null, avatarUrl: "https://example.com/ada.png" },
          role: "member",
          accounts: [ADA_EMAIL, ADA_CLOUD],
        },
      ]);
      expect(
        await roleOfAccount(ctx, { platform: ROME_CLOUD_PLATFORM, accountId: "acct-zed" }),
      ).toBeNull();
      expect(db.select().from(identities).all()).toHaveLength(1);
    });

    it("rejects an account another person holds", async () => {
      const { ctx, identity } = setup();
      await inviteMember(ctx, ADA_EMAIL.accountId);
      await identity.createPerson({ accounts: [ADA_CLOUD] });

      await expect(
        memberSignedIn(ctx, { email: ADA_EMAIL.accountId, account: ADA_CLOUD }),
      ).rejects.toBeInstanceOf(AccountTakenError);
    });
  });
});
