import { afterEach, describe, expect, it } from "@rstest/core";
import { accountCodes } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { AccountTakenError, createIdentity, UnknownPersonError } from "../identity.js";
import {
  ACCOUNT_CODE_LIFETIME_MS,
  AccountCodeExpiredError,
  accountCodeContext,
  accountCodeIssued,
  accountCodeRedeemed,
  AccountCodeUsedError,
  accountCodeVoided,
  looksLikeAccountCode,
  SignInAccountCodeError,
  UnknownAccountCodeError,
} from "./account-codes.js";

const ANN_SLACK = { platform: "slack", accountId: "T1:U7" };
const ANN_DISCORD = { platform: "discord", accountId: "42" };

describe("account codes", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  async function setup() {
    testDb = createTestDb();
    const clock = { now: new Date("2026-11-25T10:00:00Z") };
    const ctx = accountCodeContext(testDb.db, () => clock.now);
    const identity = createIdentity(testDb.db);
    const later = (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    const ann = await identity.createPerson({ accounts: [] });
    const rows = () => testDb?.db.select().from(accountCodes).all() ?? [];
    return { ctx, identity, later, ann, rows };
  }

  it("adds the account to the person the code was issued to", async () => {
    const { ctx, identity, ann } = await setup();

    const { code, expiresAt } = await accountCodeIssued(ctx, ann.id);

    expect(expiresAt).toEqual(
      new Date(Date.parse("2026-11-25T10:00:00Z") + ACCOUNT_CODE_LIFETIME_MS),
    );
    expect(await accountCodeRedeemed(ctx, code, ANN_SLACK)).toEqual({ personId: ann.id });
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(ann.id);
  });

  it("issues a code in a fixed shape with at least 50 bits of randomness", async () => {
    const { ctx, ann } = await setup();
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add((await accountCodeIssued(ctx, ann.id)).code);

    expect(codes.size).toBe(50);
    for (const code of codes) {
      expect(code).toMatch(/^ROME-[2-9A-HJKMNP-TV-Z]{6}-[2-9A-HJKMNP-TV-Z]{6}$/);
      expect(looksLikeAccountCode(code)).toBe(true);
    }
    // Twelve characters from an alphabet of 30.
    expect(12 * Math.log2(30)).toBeGreaterThanOrEqual(50);
  });

  it("refuses an expired code and changes nothing", async () => {
    const { ctx, identity, later, ann } = await setup();
    const { code } = await accountCodeIssued(ctx, ann.id);

    later(ACCOUNT_CODE_LIFETIME_MS);

    await expect(accountCodeRedeemed(ctx, code, ANN_SLACK)).rejects.toBeInstanceOf(
      AccountCodeExpiredError,
    );
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
  });

  it("refuses a code used once already", async () => {
    const { ctx, identity, ann } = await setup();
    const { code } = await accountCodeIssued(ctx, ann.id);
    await accountCodeRedeemed(ctx, code, ANN_SLACK);

    await expect(accountCodeRedeemed(ctx, code, ANN_DISCORD)).rejects.toBeInstanceOf(
      AccountCodeUsedError,
    );
    expect(await identity.accountsOf(ann.id)).toEqual([ANN_SLACK]);
  });

  it("refuses a voided code and changes nothing", async () => {
    const { ctx, identity, ann } = await setup();
    const { code } = await accountCodeIssued(ctx, ann.id);

    await accountCodeVoided(ctx, ` ${code.toLowerCase()} `);

    await expect(accountCodeRedeemed(ctx, code, ANN_SLACK)).rejects.toBeInstanceOf(
      AccountCodeUsedError,
    );
    expect(await identity.accountsOf(ann.id)).toEqual([]);
  });

  it("ignores voiding a text that is no code", async () => {
    const { ctx, ann, rows } = await setup();
    await accountCodeIssued(ctx, ann.id);
    const before = rows();

    await accountCodeVoided(ctx, "ROME-222222-222222");
    await accountCodeVoided(ctx, "hello");

    expect(rows()).toEqual(before);
  });

  it("refuses an unknown code and changes nothing", async () => {
    const { ctx, identity, ann } = await setup();
    await accountCodeIssued(ctx, ann.id);

    for (const text of ["ROME-222222-222222", "hello"]) {
      await expect(accountCodeRedeemed(ctx, text, ANN_SLACK)).rejects.toBeInstanceOf(
        UnknownAccountCodeError,
      );
    }
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
  });

  it("replaces the person's first code when a second is issued", async () => {
    const { ctx, ann, rows } = await setup();
    const first = await accountCodeIssued(ctx, ann.id);
    const second = await accountCodeIssued(ctx, ann.id);

    expect(rows()).toHaveLength(1);
    await expect(accountCodeRedeemed(ctx, first.code, ANN_SLACK)).rejects.toBeInstanceOf(
      UnknownAccountCodeError,
    );
    expect(await accountCodeRedeemed(ctx, second.code, ANN_SLACK)).toEqual({ personId: ann.id });
  });

  it("keeps one person's code when another person gets one", async () => {
    const { ctx, identity, ann, rows } = await setup();
    const bob = await identity.createPerson({ accounts: [] });
    const annCode = await accountCodeIssued(ctx, ann.id);
    await accountCodeIssued(ctx, bob.id);

    expect(rows()).toHaveLength(2);
    expect(await accountCodeRedeemed(ctx, annCode.code, ANN_SLACK)).toEqual({ personId: ann.id });
  });

  it("refuses an account another person holds, adds nothing, and uses the code up", async () => {
    const { ctx, identity, ann } = await setup();
    const bob = await identity.createPerson({ accounts: [ANN_SLACK] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await expect(accountCodeRedeemed(ctx, code, ANN_SLACK)).rejects.toBeInstanceOf(
      AccountTakenError,
    );
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(bob.id);
    expect(await identity.accountsOf(ann.id)).toEqual([]);

    await expect(accountCodeRedeemed(ctx, code, ANN_DISCORD)).rejects.toBeInstanceOf(
      AccountCodeUsedError,
    );
    expect(await identity.accountsOf(ann.id)).toEqual([]);
  });

  it("succeeds for an account the person already holds, uses the code up and changes nothing else", async () => {
    const { ctx, identity, ann } = await setup();
    await identity.addAccount(ann.id, ANN_SLACK);
    const { code } = await accountCodeIssued(ctx, ann.id);

    expect(await accountCodeRedeemed(ctx, code, ANN_SLACK)).toEqual({ personId: ann.id });
    expect(await identity.accountsOf(ann.id)).toEqual([ANN_SLACK]);
    await expect(accountCodeRedeemed(ctx, code, ANN_DISCORD)).rejects.toBeInstanceOf(
      AccountCodeUsedError,
    );
  });

  for (const platform of ["email", "rome-cloud-email"]) {
    it(`refuses a sign-in address on ${platform}, adds nothing, and uses the code up`, async () => {
      const { ctx, identity, ann } = await setup();
      const { code } = await accountCodeIssued(ctx, ann.id);

      await expect(
        accountCodeRedeemed(ctx, code, { platform, accountId: "ann@example.com" }),
      ).rejects.toBeInstanceOf(SignInAccountCodeError);
      expect(await identity.accountsOf(ann.id)).toEqual([]);
      await expect(accountCodeRedeemed(ctx, code, ANN_SLACK)).rejects.toBeInstanceOf(
        AccountCodeUsedError,
      );
    });
  }

  it("refuses to issue a code to a person Rome does not know", async () => {
    const { ctx, rows } = await setup();

    await expect(accountCodeIssued(ctx, "no-such-person")).rejects.toBeInstanceOf(
      UnknownPersonError,
    );
    expect(rows()).toEqual([]);
  });

  it("ignores case and surrounding spaces", async () => {
    const { ctx, ann } = await setup();
    const { code } = await accountCodeIssued(ctx, ann.id);
    const typed = `  ${code.toLowerCase()}\n`;

    expect(looksLikeAccountCode(typed)).toBe(true);
    expect(await accountCodeRedeemed(ctx, typed, ANN_SLACK)).toEqual({ personId: ann.id });
  });

  it("takes a code wrapped in punctuation, quotes, backticks or after /start for the code", async () => {
    const { ctx, ann } = await setup();
    const { code } = await accountCodeIssued(ctx, ann.id);
    const wrapped = [`${code}.`, `\`${code}\``, `"${code}"`, `“${code}”`, `/start ${code}`];

    for (const text of wrapped) expect(looksLikeAccountCode(text)).toBe(true);
    expect(await accountCodeRedeemed(ctx, `\`${code}\`.`, ANN_SLACK)).toEqual({ personId: ann.id });
  });

  it("does not take a code inside a longer text for a code", async () => {
    const { ctx, identity, ann } = await setup();
    const { code } = await accountCodeIssued(ctx, ann.id);

    for (const text of [`my code is ${code}`, `${code} thanks`, `${code}X`]) {
      expect(looksLikeAccountCode(text)).toBe(false);
      await expect(accountCodeRedeemed(ctx, text, ANN_SLACK)).rejects.toBeInstanceOf(
        UnknownAccountCodeError,
      );
    }
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
    expect(looksLikeAccountCode("hello there")).toBe(false);
  });

  it("stores a hash of the code and never the code", async () => {
    const { ctx, ann, rows } = await setup();
    const { code } = await accountCodeIssued(ctx, ann.id);

    const stored = JSON.stringify(rows());
    expect(rows()).toHaveLength(1);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.split("-")[1]);
    expect(stored).not.toContain(code.split("-")[2]);
  });

  it("deletes the person's open code with the person", async () => {
    const { ctx, identity, ann, rows } = await setup();
    await accountCodeIssued(ctx, ann.id);

    await identity.deletePerson(ann.id);

    expect(rows()).toEqual([]);
  });
});
