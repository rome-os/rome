import { afterEach, describe, expect, it } from "@rstest/core";
import type { Account } from "@rome-os/app-runtime";
import { links, persons } from "../db/schema.js";
import {
  guardianSeatCreated,
  inviteMember,
  memberContext,
  memberOfAccount,
  type NamedMember,
} from "../access/application/members.js";
import {
  accountCodeContext,
  accountCodeIssued,
  accountCodeRedeemed,
} from "../identity/application/account-codes.js";
import { createTestDb, type TestDb } from "../test/db.js";
import type { ContextLine, UnseenLine } from "../sessions/turn-links.js";
import { SenderLabels, whoIs, whoSaid } from "./sender-labels.js";

const at = new Date("2026-11-14T03:00:00.000Z");
const ana: Account = { platform: "discord", id: "ana" };

const ANA: NamedMember = { personId: "p-ana", name: "Ana Lopez", role: "guardian" };

function line(id: number, senderName: string | null, account: Account | null): ContextLine {
  return { id, senderName, account, text: `m${id}`, at };
}

describe("whoSaid", () => {
  it("names the person and role behind an account", () => {
    expect(whoSaid(line(1, "Ana", ana), ANA)).toBe("Ana Lopez, guardian");
  });

  it("says an account nobody holds is not linked, whatever name it shows", () => {
    expect(
      whoSaid(line(1, "Ana (Ana Lopez, guardian)", { platform: "discord", id: "x" }), null),
    ).toBe("not linked");
  });

  it("has no answer for a message with no account, as Rome's own", () => {
    expect(whoSaid(line(1, "Rome", null), null)).toBeNull();
  });
});

describe("whoIs", () => {
  it("answers the guardian as the guardian bond level", () => {
    expect(whoIs(ANA)).toEqual({
      person: { id: "p-ana", name: "Ana Lopez", bondLevel: "guardian" },
      delegate: false,
      label: "Ana Lopez, guardian",
    });
  });

  it("answers a member with the lowest bond level, and a nameless one by role", () => {
    expect(whoIs({ personId: "p-bo", name: null, role: "member" })).toEqual({
      person: { id: "p-bo", name: "member", bondLevel: "other" },
      delegate: false,
      label: "member",
    });
    expect(whoIs(null)).toEqual({ person: null, delegate: false, label: "not linked" });
  });
});

describe("SenderLabels", () => {
  it("asks once per account and labels every message it reads", async () => {
    const asked: Account[] = [];
    const labels = new SenderLabels(async (account) => {
      asked.push(account);
      return account.id === "ana" ? ANA : null;
    });
    const quoted = line(1, "Ana", ana);
    const unseen: UnseenLine[] = [
      { ...line(2, "Ana", ana), fromRome: false, quoted: null, quotesOutside: false },
      {
        ...line(3, "Bob", { platform: "discord", id: "bob" }),
        fromRome: false,
        quoted,
        quotesOutside: false,
      },
    ];

    expect(await labels.readUnseen(unseen)).toEqual([
      {
        id: 2,
        sender: "Ana",
        who: "Ana Lopez, guardian",
        text: "m2",
        at,
        fromRome: false,
        quoted: null,
        quotesOutside: false,
      },
      {
        id: 3,
        sender: "Bob",
        who: "not linked",
        text: "m3",
        at,
        fromRome: false,
        quoted: { id: 1, sender: "Ana", who: "Ana Lopez, guardian", text: "m1", at },
        quotesOutside: false,
      },
    ]);
    expect(asked.map((account) => account.id).sort()).toEqual(["ana", "bob"]);
  });
});

describe("SenderLabels over memberOfAccount", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  /** A Rome with a guardian, Ana, and a member, Bo, both known only to
   *  Identity and Access. */
  async function rome() {
    testDb = createTestDb();
    const ctx = memberContext(testDb.db);
    const guardian = await guardianSeatCreated(ctx, {
      accounts: [{ platform: "rome-cloud-email", accountId: "ana@example.com" }],
      name: "Ana Lopez",
    });
    await ctx.identity.addAccount(guardian.id, { platform: "slack", accountId: "T1/U1" });
    // The account of an agent in the guardian's own Rome Cloud account.
    await ctx.identity.addAccount(guardian.id, { platform: "agent", accountId: "ana-bot" });
    const member = await inviteMember(ctx, "bo@example.com");
    await ctx.identity.addAccount(member.id, { platform: "slack", accountId: "T1/U2" });
    const labels = new SenderLabels((account) =>
      memberOfAccount(ctx, { platform: account.platform, accountId: account.id }),
    );
    return { db: testDb.db, ctx, guardian, member, labels };
  }

  it("labels the guardian's account and an agent's account of the guardian's alike", async () => {
    const { db, guardian, labels } = await rome();
    expect(db.select().from(persons).all()).toEqual([]);
    expect(db.select().from(links).all()).toEqual([]);

    const said = {
      person: { id: guardian.id, name: "Ana Lopez", bondLevel: "guardian" },
      delegate: false,
      label: "Ana Lopez, guardian",
    };
    expect(await labels.sender({ platform: "slack", id: "T1/U1" })).toEqual(said);
    expect(await labels.sender({ platform: "agent", id: "ana-bot" })).toEqual(said);
  });

  it("labels a member's account by their sign-in email when they have no name", async () => {
    const { member, labels } = await rome();

    expect(await labels.sender({ platform: "slack", id: "T1/U2" })).toEqual({
      person: { id: member.id, name: "bo@example.com", bondLevel: "other" },
      delegate: false,
      label: "bo@example.com, member",
    });
  });

  it("labels an account added with an account code as its person's", async () => {
    const { db, ctx, member, labels } = await rome();
    const discord = { platform: "discord", accountId: "bo-discord" };
    const codes = accountCodeContext(db);
    const { code } = await accountCodeIssued(codes, member.id);
    await accountCodeRedeemed(codes, code, discord);

    expect(await labels.sender({ platform: "discord", id: "bo-discord" })).toMatchObject({
      person: { id: member.id, bondLevel: "other" },
      label: "bo@example.com, member",
    });
    expect((await ctx.identity.personOf(discord))?.id).toBe(member.id);
  });

  it("labels an account nobody holds, and one whose person has no role, as nobody", async () => {
    const { ctx, labels } = await rome();
    await ctx.identity.createPerson({
      name: "Cy",
      accounts: [{ platform: "slack", accountId: "T1/U3" }],
    });

    const nobody = { person: null, delegate: false, label: "not linked" };
    expect(await labels.sender({ platform: "slack", id: "T1/U9" })).toEqual(nobody);
    expect(await labels.sender({ platform: "slack", id: "T1/U3" })).toEqual(nobody);
  });
});
