import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import {
  guardianSeatCreated,
  inviteMember,
  memberContext,
  type MemberContext,
  seatAccounts,
} from "../../access/application/members.js";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import { accountClaims } from "../../db/schema.js";
import {
  accountCodeContext,
  accountCodeRedeemed,
  looksLikeAccountCode,
} from "../../identity/application/account-codes.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { accountCodesRoutes } from "./account-codes.js";

const ANN_SLACK = { platform: "slack", accountId: "T1:U7" };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };
const NOW = new Date("2026-11-25T10:00:00Z");

describe("account codes API", () => {
  let testDb: TestDb;
  let app: Hono;
  let ctx: MemberContext;

  beforeEach(() => {
    testDb = createTestDb();
    ctx = memberContext(testDb.db);
    app = new Hono().route(
      "/",
      accountCodesRoutes({ db: testDb.db }, () => NOW),
    );
  });

  afterEach(() => testDb.close());

  const ask = (as: SessionActor | undefined, headers: Record<string, string> = SAME_ORIGIN) => {
    const request = () => app.request("/account-codes", { method: "POST", headers });
    return as ? runWithSessionActor(as, request) : request();
  };
  const redeemedBy = async (code: string) =>
    (
      await accountCodeRedeemed(
        accountCodeContext(testDb.db, () => NOW),
        code,
        ANN_SLACK,
      )
    ).personId;
  const stored = () => testDb.db.select().from(accountClaims).all();

  it("gives a member a code of their own", async () => {
    const ann = await inviteMember(ctx, "ann@example.com");

    const res = await ask({ kind: "visitor", accountId: "acct-ann", email: "Ann@Example.com" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(["code", "expiresAt"]);
    expect(looksLikeAccountCode(body.code)).toBe(true);
    expect(body.expiresAt).toBe("2026-11-25T10:10:00.000Z");
    expect(await redeemedBy(body.code)).toBe(ann.id);
  });

  it("gives the guardian signed in with Rome Cloud a code", async () => {
    const guardian = await guardianSeatCreated(ctx, {
      accounts: seatAccounts({ email: "owner@example.com" }),
    });

    const res = await ask({
      kind: "guardian",
      userId: "seat",
      email: "owner@example.com",
      via: "cookie",
    });

    expect(res.status).toBe(200);
    expect(await redeemedBy(((await res.json()) as { code: string }).code)).toBe(guardian.id);
  });

  it("gives the guardian signed in with the local password a code", async () => {
    const guardian = await guardianSeatCreated(ctx, { accounts: seatAccounts({}) });

    const res = await ask({ kind: "guardian", userId: "seat", via: "cookie" });

    expect(res.status).toBe(200);
    expect(await redeemedBy(((await res.json()) as { code: string }).code)).toBe(guardian.id);
  });

  it("refuses a session that belongs to no person", async () => {
    const res = await ask({ kind: "visitor", accountId: "acct-x", email: "stranger@example.com" });

    expect(res.status).toBe(403);
    expect(stored()).toEqual([]);
  });

  it("refuses a caller who is not signed in", async () => {
    await inviteMember(ctx, "ann@example.com");

    expect((await ask({ kind: "anonymous" })).status).toBe(401);
    expect((await ask(undefined)).status).toBe(401);
    expect(stored()).toEqual([]);
  });

  it("refuses a cross-site post", async () => {
    await inviteMember(ctx, "ann@example.com");

    const res = await ask(
      { kind: "visitor", accountId: "acct-ann", email: "ann@example.com" },
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    );

    expect(res.status).toBe(403);
    expect(stored()).toEqual([]);
  });

  it("refuses an agent acting as the guardian's seat over loopback", async () => {
    await guardianSeatCreated(ctx, { accounts: seatAccounts({ email: "owner@example.com" }) });

    const res = await ask({
      kind: "guardian",
      userId: "seat",
      email: "owner@example.com",
      via: "loopback",
    });

    expect(res.status).toBe(403);
    expect(stored()).toEqual([]);
  });
});
