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
import { accountClaimStarted, claimContext } from "../../identity/application/account-claims.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { accountClaimsRoutes } from "./account-claims.js";

const ANN_SLACK = { platform: "slack", accountId: "T1:U7" };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

describe("account claims API", () => {
  let testDb: TestDb;
  let app: Hono;
  let ctx: MemberContext;

  beforeEach(() => {
    testDb = createTestDb();
    ctx = memberContext(testDb.db);
    app = new Hono().route("/", accountClaimsRoutes({ db: testDb.db }));
  });

  afterEach(() => testDb.close());

  const start = async () => (await accountClaimStarted(claimContext(testDb.db), ANN_SLACK)).token;
  const confirm = (as: SessionActor | undefined, token: string) => {
    const request = () =>
      app.request(`/account-claims/${token}/confirm`, { method: "POST", headers: SAME_ORIGIN });
    return as ? runWithSessionActor(as, request) : request();
  };
  const holder = async () => (await ctx.identity.personOf(ANN_SLACK))?.id ?? null;

  it("shows a member what the claim is for and changes nothing", async () => {
    await inviteMember(ctx, "ann@example.com");
    const token = await start();
    const ann = { kind: "visitor", accountId: "acct-ann", email: "ann@example.com" } as const;

    const res = await runWithSessionActor(ann, () => app.request(`/account-claims/${token}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ platform: "slack", account: "T1:U7" });
    expect(await holder()).toBeNull();
    const missing = await runWithSessionActor(ann, () => app.request("/account-claims/nope"));
    expect(missing.status).toBe(404);
  });

  it("adds the account to a member who confirms", async () => {
    const ann = await inviteMember(ctx, "ann@example.com");
    const token = await start();

    const res = await confirm(
      { kind: "visitor", accountId: "acct-ann", email: "Ann@Example.com" },
      token,
    );

    expect(res.status).toBe(200);
    expect(await holder()).toBe(ann.id);
    expect(
      (await confirm({ kind: "visitor", accountId: "a", email: "ann@example.com" }, token)).status,
    ).toBe(404);
  });

  it("adds the account to a guardian signed in with Rome Cloud", async () => {
    const guardian = await guardianSeatCreated(ctx, {
      accounts: seatAccounts({ email: "owner@example.com" }),
    });
    const token = await start();

    const res = await confirm(
      { kind: "guardian", userId: "seat", email: "owner@example.com", via: "cookie" },
      token,
    );

    expect(res.status).toBe(200);
    expect(await holder()).toBe(guardian.id);
  });

  it("adds the account to a guardian signed in with the local password", async () => {
    const guardian = await guardianSeatCreated(ctx, { accounts: seatAccounts({}) });
    const token = await start();

    const res = await confirm({ kind: "guardian", userId: "seat", via: "cookie" }, token);

    expect(res.status).toBe(200);
    expect(await holder()).toBe(guardian.id);
  });

  it("refuses a session that belongs to no person", async () => {
    const token = await start();

    const res = await confirm(
      { kind: "visitor", accountId: "acct-x", email: "stranger@example.com" },
      token,
    );

    expect(res.status).toBe(403);
    expect(await holder()).toBeNull();
  });

  it("refuses a caller who is not signed in", async () => {
    await inviteMember(ctx, "ann@example.com");
    const token = await start();

    expect((await confirm({ kind: "anonymous" }, token)).status).toBe(401);
    expect((await confirm(undefined, token)).status).toBe(401);
    expect((await app.request(`/account-claims/${token}`)).status).toBe(401);
    expect(await holder()).toBeNull();
  });

  it("refuses an agent acting as the guardian's seat, and a cross-site post", async () => {
    await guardianSeatCreated(ctx, { accounts: seatAccounts({ email: "owner@example.com" }) });
    const token = await start();
    const viaCookie = {
      kind: "guardian",
      userId: "seat",
      email: "owner@example.com",
      via: "cookie",
    } as const;

    expect((await confirm({ ...viaCookie, via: "loopback" }, token)).status).toBe(403);
    const crossSite = await runWithSessionActor(viaCookie, () =>
      app.request(`/account-claims/${token}/confirm`, {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      }),
    );
    expect(crossSite.status).toBe(403);
    expect(await holder()).toBeNull();
  });

  it("answers 409 when someone took the account after the claim started", async () => {
    await inviteMember(ctx, "ann@example.com");
    const token = await start();
    const bob = await ctx.identity.createPerson({ accounts: [ANN_SLACK] });

    const res = await confirm(
      { kind: "visitor", accountId: "acct-ann", email: "ann@example.com" },
      token,
    );

    expect(res.status).toBe(409);
    expect(await holder()).toBe(bob.id);
  });
});
