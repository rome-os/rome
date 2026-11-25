import { afterEach, describe, expect, it } from "@rstest/core";
import { identities, teamMembers } from "../db/schema.js";
import { createIdentities } from "../identity/identities.js";
import { createTestDb, type TestDb } from "../test/db.js";
import {
  createTeam,
  GuardianRemovalError,
  NotOnTeamError,
  putSeatOnTeam,
  ROME_CLOUD_PLATFORM,
  recordSignInOnTeam,
} from "./team-members.js";

const OWNER_CLOUD = { platform: ROME_CLOUD_PLATFORM, accountId: "acct-owner" };
const OWNER_EMAIL = { platform: "email", accountId: "owner@example.com" };
const ADA_EMAIL = { platform: "email", accountId: "ada@example.com" };
const ADA_CLOUD = { platform: ROME_CLOUD_PLATFORM, accountId: "acct-ada" };

describe("Team", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup() {
    testDb = createTestDb();
    return { db: testDb.db, team: createTeam(testDb.db), identity: createIdentities(testDb.db) };
  }

  it("answers each member's role by account and by person", async () => {
    const { team } = setup();
    const owner = await team.ensureGuardian({ accounts: [OWNER_CLOUD], name: "Owner" });
    const ada = await team.addTeammateByEmail("Ada@Example.com");

    expect(await team.roleOf(OWNER_CLOUD)).toBe("guardian");
    expect(await team.roleOf(ADA_EMAIL)).toBe("teammate");
    expect(await team.roleOfPerson(owner.id)).toBe("guardian");
    expect(await team.roleOfPerson(ada.id)).toBe("teammate");
    expect(await team.members()).toEqual([
      {
        identity: { id: owner.id, name: "Owner", avatarUrl: null },
        role: "guardian",
        accounts: [OWNER_CLOUD],
      },
      {
        identity: { id: ada.id, name: null, avatarUrl: null },
        role: "teammate",
        accounts: [ADA_EMAIL],
      },
    ]);
  });

  it("answers null for an account nobody holds and for a person off the team", async () => {
    const { team, identity } = setup();
    const stranger = await identity.create({
      accounts: [{ platform: "slack", accountId: "T1:U1" }],
    });

    expect(await team.roleOf({ platform: "slack", accountId: "T1:U9" })).toBeNull();
    expect(await team.roleOf({ platform: "slack", accountId: "T1:U1" })).toBeNull();
    expect(await team.roleOfPerson(stranger.id)).toBeNull();
  });

  it("keeps one guardian, and a second ensureGuardian only adds the accounts they lack", async () => {
    const { db, team } = setup();
    const first = await team.ensureGuardian({ accounts: [OWNER_CLOUD], name: "Owner" });
    const again = await team.ensureGuardian({
      accounts: [OWNER_CLOUD, OWNER_EMAIL],
      name: "Other",
    });
    await team.ensureGuardian({ accounts: [OWNER_CLOUD, OWNER_EMAIL] });

    expect(again).toEqual(first);
    expect(db.select().from(teamMembers).all()).toHaveLength(1);
    expect(db.select().from(identities).all()).toHaveLength(1);
    expect((await team.members())[0]?.accounts).toEqual([OWNER_EMAIL, OWNER_CLOUD]);
  });

  it("refuses a second guardian row in the table itself", async () => {
    const { db, team, identity } = setup();
    await team.ensureGuardian({ accounts: [] });
    const other = await identity.create({ accounts: [] });

    expect(() =>
      db
        .insert(teamMembers)
        .values({ identityId: other.id, role: "guardian", createdAt: new Date() })
        .run(),
    ).toThrow();
  });

  it("moves an account another person holds to the guardian", async () => {
    const { team } = setup();
    const ada = await team.addTeammateByEmail(ADA_EMAIL.accountId);
    const owner = await team.ensureGuardian({ accounts: [ADA_EMAIL] });

    expect(await team.roleOf(ADA_EMAIL)).toBe("guardian");
    expect((await team.members()).find((m) => m.identity.id === ada.id)?.accounts).toEqual([]);
    expect(owner.id).not.toBe(ada.id);
  });

  it("answers the guardian for their own email instead of adding a teammate", async () => {
    const { team } = setup();
    const owner = await team.ensureGuardian({ accounts: [OWNER_EMAIL] });

    expect((await team.addTeammateByEmail("owner@example.com")).id).toBe(owner.id);
    expect(await team.roleOfPerson(owner.id)).toBe("guardian");
  });

  it("puts a person who already holds the email on the team without making another", async () => {
    const { db, team, identity } = setup();
    const ada = await identity.create({ accounts: [ADA_EMAIL] });

    expect((await team.addTeammateByEmail(ADA_EMAIL.accountId)).id).toBe(ada.id);
    expect(db.select().from(identities).all()).toHaveLength(1);
    expect(await team.roleOfPerson(ada.id)).toBe("teammate");
  });

  it("removes a teammate by deleting the person and freeing their accounts", async () => {
    const { db, team, identity } = setup();
    const ada = await team.addTeammateByEmail(ADA_EMAIL.accountId);
    await team.recordAccount(ada.id, ADA_CLOUD);

    await team.removeTeammateByEmail("ADA@example.com");

    expect(await team.roleOf(ADA_CLOUD)).toBeNull();
    expect(await identity.personOf(ADA_EMAIL)).toBeNull();
    expect(await identity.personOf(ADA_CLOUD)).toBeNull();
    expect(db.select().from(teamMembers).all()).toEqual([]);
    await identity.create({ accounts: [ADA_CLOUD] });
  });

  it("refuses to remove the guardian and changes nothing", async () => {
    const { team } = setup();
    const owner = await team.ensureGuardian({ accounts: [OWNER_EMAIL] });

    await expect(team.removeTeammateByEmail(OWNER_EMAIL.accountId)).rejects.toBeInstanceOf(
      GuardianRemovalError,
    );
    expect(await team.roleOfPerson(owner.id)).toBe("guardian");
    expect(await team.roleOf(OWNER_EMAIL)).toBe("guardian");
  });

  it("leaves a person off the team alone when removing their email", async () => {
    const { team, identity } = setup();
    const stranger = await identity.create({ accounts: [ADA_EMAIL] });

    await team.removeTeammateByEmail(ADA_EMAIL.accountId);
    await team.removeTeammateByEmail("nobody@example.com");

    expect((await identity.personOf(ADA_EMAIL))?.id).toBe(stranger.id);
  });

  it("makes the teammates exactly the listed emails and never touches the guardian", async () => {
    const { team } = setup();
    await team.ensureGuardian({ accounts: [OWNER_EMAIL] });
    await team.setTeammateEmails(["ada@example.com", "lin@example.com"]);
    await team.setTeammateEmails(["lin@example.com", "owner@example.com"]);

    const members = await team.members();
    expect(members.map((m) => [m.role, m.accounts.map((a) => a.accountId)])).toEqual([
      ["guardian", ["owner@example.com"]],
      ["teammate", ["lin@example.com"]],
    ]);
    expect(await team.roleOf(ADA_EMAIL)).toBeNull();
  });

  it("records an account only on a person on the team", async () => {
    const { team, identity } = setup();
    const stranger = await identity.create({ accounts: [] });

    await expect(team.recordAccount(stranger.id, ADA_CLOUD)).rejects.toBeInstanceOf(NotOnTeamError);
    expect(await identity.personOf(ADA_CLOUD)).toBeNull();
  });

  it("records a teammate's sign-in with their avatar, and no person for a visitor off the team", async () => {
    const { db, team } = setup();
    const ada = await team.addTeammateByEmail(ADA_EMAIL.accountId);

    await recordSignInOnTeam(db, {
      email: "Ada@example.com",
      accountId: ADA_CLOUD.accountId,
      avatarUrl: "https://example.com/ada.png",
    });
    await recordSignInOnTeam(db, {
      email: "zed@example.com",
      accountId: "acct-zed",
      avatarUrl: null,
    });

    expect(await team.members()).toEqual([
      {
        identity: { id: ada.id, name: null, avatarUrl: "https://example.com/ada.png" },
        role: "teammate",
        accounts: [ADA_EMAIL, ADA_CLOUD],
      },
    ]);
    expect(await team.roleOf({ platform: ROME_CLOUD_PLATFORM, accountId: "acct-zed" })).toBeNull();
    expect(db.select().from(identities).all()).toHaveLength(1);
  });

  it("puts a seat's guardian on the team with the seat's accounts, and a local seat with none", async () => {
    const { db, team } = setup();
    await putSeatOnTeam(db, { name: "owner" });
    await putSeatOnTeam(db, { accountId: "acct-owner", email: " Owner@Example.com" });

    expect(await team.members()).toEqual([
      {
        identity: expect.objectContaining({ name: "owner" }),
        role: "guardian",
        accounts: [OWNER_EMAIL, OWNER_CLOUD],
      },
    ]);
  });
});
