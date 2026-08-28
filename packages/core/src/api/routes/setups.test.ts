// The generic conferral-setup routes, black-box through Hono.
//
// Seams under test: the four HTTP routes over a real ConnectionRegistry (drizzle
// ledger) + a real SetupManager, driving a fixture descriptor whose `bot`
// grant carries a setup. We prove: start-or-re-attach, poll, input drives the
// terminal conferral (a connection is minted and its credential imported),
// cancel, idempotent late delivery, and the same-origin guard.

import { Hono } from "hono";
import { afterEach, describe, expect, it, rs } from "@rstest/core";

// The OAuth provider descriptor's custody hook writes the tmpfs token file +
// spawns `gh` off the terminal conferral. This suite exercises the setup
// coroutine + terminal write, not custody, so stub both custody libs: they keep
// the confer off the real disk / `gh` binary AND deterministic — an un-mocked
// `gh` spawn (ENOENT) is slow enough on a loaded CI runner to push the `done`
// transition past the poll's default timeout (the terminal write awaits custody).
rs.mock("../../lib/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider: rs.fn(async () => {}),
  clearGithubShellIntegrationForProvider: rs.fn(async () => {}),
}));
rs.mock("../../lib/provider-token-files.js", () => ({
  syncProviderTokenFile: rs.fn(async () => {}),
  clearProviderTokenFile: rs.fn(async () => {}),
}));

import { SetupManager } from "../../connections/setup/manager.js";
import type { SetupFn } from "../../connections/setup/types.js";
import { DrizzleGrantLedger } from "../../connections/ledger-db.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { makePasteTalk } from "../../connections/test-fixtures.js";
import {
  createFeishuDescriptor,
  type FeishuPendingMaterial,
} from "../../connections/integrations/feishu.js";
import { makeOAuthProviderDescriptor } from "../../connections/integrations/oauth-providers.js";
import type { Credential, ProfileRecord } from "../../connections/types.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { createTestDb } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";
import { setupsRoutes } from "./setups.js";
import { connectionsRoutes } from "./connections.js";

const SAME_ORIGIN = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});

/** A setup: prompt a token, confer it as the grant credential + a guardian
 *  mapping. Rejects the token "bad" once (re-prompt) so we can exercise that. */
const setupFn: SetupFn = async (interact) => {
  let error: string | undefined;
  let token: string;
  for (;;) {
    ({ token } = await interact.prompt({
      instructions: "Paste the bot token.",
      fields: [{ name: "token", label: "Bot token", secret: true }],
      ...(error ? { error } : {}),
    }));
    if (token !== "bad") break;
    error = "That token was rejected.";
  }
  interact.show({ title: "Almost there", body: ["Verifying…"], progress: true });
  return {
    credential: { material: { token }, expiresAt: "never" },
    profile: { botUsername: "rome" },
    guardianChannelUserId: "guardian-1",
    summary: { title: "Connected", body: ["Your bot is live."] },
  };
};

function fakePersonRepo(): PersonMappingRepository {
  return {
    findByChannelUser: async () => null,
    findByBondLevel: async () => [{ id: "guardian", channelMappings: [] }],
    // The terminal conferral applies the guardian mapping through the synchronous
    // write helpers enlisted in its transaction — not the async setters.
    writeChannelUserId: rs.fn(),
    writeChannelMapping: rs.fn(() => "id"),
    deleteGuardianChannelMappings: rs.fn(),
  } as unknown as PersonMappingRepository;
}

function harness() {
  const { db, close } = createTestDb();
  openDbs.push(close);
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
  const fixture = makePasteTalk();
  fixture.descriptor.service = "fake-telegram";
  fixture.descriptor.auth.bot.setup = setupFn;
  registry.register(fixture.descriptor);
  const personMappingRepo = fakePersonRepo();
  const manager = new SetupManager({ registry, personMappingRepo });
  const deps = {
    connectionRegistry: registry,
    setupManager: manager,
    personMappingRepo,
  } as unknown as ApiDeps;
  const app = new Hono().route("/", setupsRoutes(deps)).route("/", connectionsRoutes(deps));
  return { app, registry };
}

async function start(app: Hono, id = "fake-telegram", body: object = {}) {
  const res = await app.request(`/connections/${id}/grants/bot/setup`, {
    method: "POST",
    headers: SAME_ORIGIN,
    body: JSON.stringify(body),
  });
  return {
    res,
    json: (await res.json()) as { cid: string; state: { status: string }; reattached: boolean },
  };
}

describe("POST /connections/:id/grants/:name/setup", () => {
  it("starts a setup for a never-connected service (placeholder addressing)", async () => {
    const { app } = harness();
    const { res, json } = await start(app);
    expect(res.status).toBe(200);
    expect(json.reattached).toBe(false);
    expect(json.state.status).toBe("awaiting-input");
    expect(json.cid).toBeTruthy();
  });

  it("re-attaches a second start to the same live setup", async () => {
    const { app } = harness();
    const first = await start(app);
    const second = await start(app);
    expect(second.json.reattached).toBe(true);
    expect(second.json.cid).toBe(first.json.cid);
  });

  it("404s when the grant declares no setup", async () => {
    const { app } = harness();
    const res = await app.request("/connections/fake-telegram/grants/nope/setup", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("blocks cross-origin starts", async () => {
    const { app } = harness();
    const res = await app.request("/connections/fake-telegram/grants/bot/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /setups/:cid", () => {
  it("polls the current state", async () => {
    const { app } = harness();
    const { json } = await start(app);
    const res = await app.request(`/setups/${json.cid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { status: string; form?: unknown } };
    expect(body.state.status).toBe("awaiting-input");
    expect(body.state.form).toBeDefined();
  });

  it("404s an unknown setup", async () => {
    const { app } = harness();
    const res = await app.request("/setups/nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /setups/:cid/input", () => {
  it("re-prompts on a rejected token, then confers on a good one", async () => {
    const { app, registry } = harness();
    const { json } = await start(app);

    const bad = await app.request(`/setups/${json.cid}/input`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ answers: { token: "bad" } }),
    });
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as {
      accepted: boolean;
      state: { status: string; error?: string };
    };
    expect(badBody.accepted).toBe(true);
    expect(badBody.state.status).toBe("awaiting-input");
    expect(badBody.state.error).toBe("That token was rejected.");

    const good = await app.request(`/setups/${json.cid}/input`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ answers: { token: "good" } }),
    });
    const goodBody = (await good.json()) as { state: { status: string } };
    expect(goodBody.state.status).toBe("done");

    // Terminal conferral minted the connection and imported the credential.
    const conn = registry.find("fake-telegram")[0];
    expect(conn).toBeDefined();
    const grant = await registry.getLedger().getGrant(conn.id, "bot");
    expect(grant?.state).toBe("authorized");
  });

  it("409s a late input once the setup is done", async () => {
    const { app } = harness();
    const { json } = await start(app);
    await app.request(`/setups/${json.cid}/input`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ answers: { token: "good" } }),
    });
    const late = await app.request(`/setups/${json.cid}/input`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ answers: { token: "again" } }),
    });
    expect(late.status).toBe(409);
    const body = (await late.json()) as { accepted: boolean };
    expect(body.accepted).toBe(false);
  });
});

describe("POST /setups/:cid/cancel", () => {
  it("cancels a live setup and reports cancelled thereafter", async () => {
    const { app, registry } = harness();
    const { json } = await start(app);
    const res = await app.request(`/setups/${json.cid}/cancel`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { status: string } };
    expect(body.state.status).toBe("cancelled");
    // Zero durable state: no connection was minted.
    expect(registry.find("fake-telegram")).toHaveLength(0);
  });
});

async function submitInput(app: Hono, cid: string, token: string): Promise<Response> {
  return app.request(`/setups/${cid}/input`, {
    method: "POST",
    headers: SAME_ORIGIN,
    body: JSON.stringify({ answers: { token } }),
  });
}

// Cutover (#1607): the REAL Feishu descriptor's setup, end-to-end
// through the generic routes — mode/domain prompt, manual credential probe or
// the agent-ready registerApp dance (QR presented mid-step), the in-setup
// guardian link, and the terminal conferral (credential + profile + guardian
// mapping in one write; nothing durable before it).
describe("Feishu setup through the generic routes (#1607)", () => {
  function feishuHarness(overrides: Parameters<typeof feishuDeps>[0] = {}) {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
    const personRepo = {
      findByChannelUser: async () => null,
      findByBondLevel: async () => [{ id: "guardian", channelMappings: [] }],
      // The terminal conferral applies the guardian mapping through the synchronous
      // write helpers enlisted in its transaction — not the async setters.
      writeChannelUserId: rs.fn(),
      writeChannelMapping: rs.fn(() => "id"),
    };
    registry.register(feishuDeps(overrides, personRepo));
    const manager = new SetupManager({
      registry,
      personMappingRepo: personRepo as unknown as PersonMappingRepository,
    });
    const deps = { connectionRegistry: registry, setupManager: manager } as unknown as ApiDeps;
    const app = new Hono().route("/", setupsRoutes(deps)).route("/", connectionsRoutes(deps));
    return { app, registry, personRepo };
  }

  interface FeishuFakes {
    probeCredentials?: (m: FeishuPendingMaterial, signal?: AbortSignal) => Promise<void>;
    registerAgentApp?: (opts: {
      domain: "feishu" | "lark";
      signal: AbortSignal;
      onQrCode: (qr: { url: string; qrDataUrl: string | null; expiresAt: string | null }) => void;
    }) => Promise<FeishuPendingMaterial>;
    waitForGuardianLink?: (
      m: FeishuPendingMaterial,
      code: string,
      signal: AbortSignal,
    ) => Promise<{ channelUserId: string }>;
  }

  function feishuDeps(fakes: FeishuFakes, personRepo: unknown) {
    // A fake LarkChannel keeps the Talk epoch built post-conferral off the network.
    const fakeLarkChannel = {
      async connect() {},
      async disconnect() {},
      on() {
        return () => {};
      },
    };
    return createFeishuDescriptor({
      conversationSettings: {} as never,
      personMappingRepo: personRepo as PersonMappingRepository,
      listAgents: () => [],
      createChannel: () => fakeLarkChannel as never,
      probeCredentials: fakes.probeCredentials ?? (async () => {}),
      registerAgentApp:
        fakes.registerAgentApp ??
        (async () => ({ appId: "cli_minted", appSecret: "minted", domain: "feishu" as const })),
      waitForGuardianLink:
        fakes.waitForGuardianLink ?? (async () => ({ channelUserId: "ou_guardian" })),
      generateVerificationCode: () => "424242",
    });
  }

  async function feed(app: Hono, cid: string, answers: Record<string, string>) {
    const res = await app.request(`/setups/${cid}/input`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ answers }),
    });
    return (await res.json()) as {
      state: { status: string; view?: { body?: string[]; links?: { url: string }[] } };
    };
  }

  it("manual mode: prompts, probes, links the guardian, and confers in one terminal write", async () => {
    let resolveLink!: (v: { channelUserId: string }) => void;
    const { app, registry, personRepo } = feishuHarness({
      waitForGuardianLink: () =>
        new Promise<{ channelUserId: string }>((res) => {
          resolveLink = res;
        }),
    });

    const startRes = await app.request("/connections/feishu/grants/app/setup", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(startRes.status).toBe(200);
    const { cid, state } = (await startRes.json()) as { cid: string; state: { status: string } };
    expect(state.status).toBe("awaiting-input");

    const afterMode = await feed(app, cid, { mode: "manual", domain: "lark" });
    expect(afterMode.state.status).toBe("awaiting-input");
    const afterCreds = await feed(app, cid, { appId: "cli_abc", appSecret: "shh" });
    // Guardian-link wait: the one-time code is in the presented payload.
    expect(afterCreds.state.status).toBe("presenting");
    expect(afterCreds.state.view?.body).toContain("424242");

    // Nothing durable before the terminal conferral.
    expect(registry.find("feishu")).toHaveLength(0);

    resolveLink({ channelUserId: "ou_guardian" });
    await rs.waitFor(async () => {
      const poll = await app.request(`/setups/${cid}`);
      expect(((await poll.json()) as { state: { status: string } }).state.status).toBe("done");
    });

    // One terminal write: credential + profile landed and the guardian mapped.
    const conn = registry.find("feishu")[0];
    expect(conn).toBeDefined();
    const grant = await registry.getLedger().getGrant(conn.id, "app");
    expect(grant?.state).toBe("authorized");
    expect(grant?.profile).toEqual({ appId: "cli_abc", domain: "lark", appType: "manual" });
    expect(personRepo.writeChannelMapping).toHaveBeenCalledWith(
      expect.anything(),
      "guardian",
      "feishu",
      "ou_guardian",
    );
  });

  it("agent-ready mode: presents the QR mid-step and confers the minted credential", async () => {
    let emitQr!: (qr: { url: string; qrDataUrl: string | null; expiresAt: string | null }) => void;
    let resolveMinted!: (m: FeishuPendingMaterial) => void;
    const { app, registry } = feishuHarness({
      registerAgentApp: (opts) => {
        emitQr = opts.onQrCode;
        return new Promise<FeishuPendingMaterial>((res) => {
          resolveMinted = res;
        });
      },
    });

    const startRes = await app.request("/connections/feishu/grants/app/setup", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    const { cid } = (await startRes.json()) as { cid: string };
    const afterMode = await feed(app, cid, { mode: "agent-ready", domain: "feishu" });
    expect(afterMode.state.status).toBe("presenting");

    emitQr({
      url: "https://accounts.feishu.cn/x",
      qrDataUrl: "data:image/png;base64,QR",
      expiresAt: null,
    });
    await rs.waitFor(async () => {
      const poll = await app.request(`/setups/${cid}`);
      const body = (await poll.json()) as { state: { view?: { links?: { url: string }[] } } };
      expect((body.state.view?.links ?? []).map((l) => l.url)).toContain(
        "data:image/png;base64,QR",
      );
    });

    resolveMinted({ appId: "cli_minted", appSecret: "minted", domain: "lark" });
    await rs.waitFor(async () => {
      const poll = await app.request(`/setups/${cid}`);
      expect(((await poll.json()) as { state: { status: string } }).state.status).toBe("done");
    });
    const conn = registry.find("feishu")[0];
    const grant = await registry.getLedger().getGrant(conn.id, "app");
    expect(grant?.state).toBe("authorized");
    expect(grant?.profile).toEqual({ appId: "cli_minted", domain: "lark", appType: "agent_ready" });
  });

  it("cancel mid-agent-ready interrupts the wait and leaves zero durable state", async () => {
    let stepSignal: AbortSignal | undefined;
    const { app, registry, personRepo } = feishuHarness({
      registerAgentApp: (opts) =>
        new Promise<FeishuPendingMaterial>((_res, rej) => {
          stepSignal = opts.signal;
          opts.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        }),
    });

    const startRes = await app.request("/connections/feishu/grants/app/setup", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    const { cid } = (await startRes.json()) as { cid: string };
    await feed(app, cid, { mode: "agent-ready", domain: "feishu" });

    const cancelRes = await app.request(`/setups/${cid}/cancel`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as { state: { status: string } }).state.status).toBe(
      "cancelled",
    );
    expect(stepSignal?.aborted).toBe(true);
    // Zero durable state: no connection minted, no guardian mapping.
    expect(registry.find("feishu")).toHaveLength(0);
    expect(personRepo.writeChannelMapping).not.toHaveBeenCalled();
  });
});

// Finding #3 — the setup must import into the connection the route addressed,
// not blindly into find(service)[0].
describe("addressed-connection targeting (#3)", () => {
  it("confers into the existing connection named by :id, minting no duplicate", async () => {
    const { app, registry } = harness();
    // Pre-create the connection so :id addresses a real row.
    const conn = await registry.connect("fake-telegram");
    const { json } = await start(app, conn.id);
    await submitInput(app, json.cid, "good");

    // Same connection got authorized; no second connection was minted.
    expect(registry.find("fake-telegram")).toHaveLength(1);
    const grant = await registry.getLedger().getGrant(conn.id, "bot");
    expect(grant?.state).toBe("authorized");
  });
});

// Finding #4 — tearing down a grant must cancel a live setup on it and revoke
// atomically, so the setup cannot re-import the credential after the revoke.
describe("teardown serialization (#4)", () => {
  it("cancels an in-flight setup on grant teardown; a late completion cannot re-import", async () => {
    const { app, registry } = harness();
    // First setup authorizes the grant (mints the connection).
    const first = await start(app);
    await submitInput(app, first.json.cid, "good");
    const conn = registry.find("fake-telegram")[0];
    expect((await registry.getLedger().getGrant(conn.id, "bot"))?.state).toBe("authorized");

    // A second setup on the same connection, left in-flight (awaiting input).
    const second = await start(app, conn.id);
    expect(second.json.state.status).toBe("awaiting-input");

    // Tear down the grant while the setup is live.
    const del = await app.request(`/connections/${conn.id}/grants/bot`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(del.status).toBe(200);

    // The in-flight setup was cancelled by teardown...
    const poll = await app.request(`/setups/${second.json.cid}`);
    expect(((await poll.json()) as { state: { status: string } }).state.status).toBe("cancelled");
    // ...and the grant is revoked.
    expect((await registry.getLedger().getGrant(conn.id, "bot"))?.state).toBe("unauthorized");

    // Completing the cancelled setup is a no-op (409) and never re-imports.
    const late = await submitInput(app, second.json.cid, "good");
    expect(late.status).toBe(409);
    expect((await registry.getLedger().getGrant(conn.id, "bot"))?.state).toBe("unauthorized");
  });
});

// OAuth cutover (#1611): the Rome Cloud-brokered `redirect` mechanic
// end-to-end through the generic surface — start suspends at `awaiting-redirect`
// (broker authorize URL), `POST /setups/return` resumes the coroutine correlated
// by the `state` param, the redeem runs in a `ctx.step`, and the terminal
// conferral is the single durable write. Plus the return-leg edge cases the
// spike called out: double-delivery, return-after-cancel, unknown/expired state,
// denied consent.
describe("OAuth redirect setup + return leg (#1611)", () => {
  const AUTHORIZE_URL = "https://broker.example/authorize?state=st-oauth-1&callbackOrigin=x";

  interface OAuthFakes {
    beginRedirect?: () => Promise<string>;
    redeem?: (
      handoff: string,
      state: string,
    ) => Promise<{ credential: Credential; profile?: ProfileRecord }>;
  }

  function oauthHarness(fakes: OAuthFakes = {}) {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
    registry.register(
      makeOAuthProviderDescriptor("github", {
        beginRedirect: fakes.beginRedirect ?? (async () => AUTHORIZE_URL),
        redeem:
          fakes.redeem ??
          (async (handoff) => ({
            credential: { material: { accessToken: `tok-${handoff}` }, expiresAt: "never" },
            profile: { login: "octocat" },
          })),
      }),
    );
    const manager = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const deps = { connectionRegistry: registry, setupManager: manager } as unknown as ApiDeps;
    const app = new Hono().route("/", setupsRoutes(deps)).route("/", connectionsRoutes(deps));
    return { app, registry };
  }

  async function startOAuth(app: Hono) {
    const res = await app.request("/connections/github/grants/user/setup", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    return {
      res,
      json: (await res.json()) as {
        cid: string;
        state: { status: string; url?: string };
      },
    };
  }

  async function deliverReturn(app: Hono, body: Record<string, string>) {
    return app.request("/setups/return", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify(body),
    });
  }

  async function pollDone(app: Hono, cid: string) {
    await rs.waitFor(
      async () => {
        const poll = await app.request(`/setups/${cid}`);
        expect(((await poll.json()) as { state: { status: string } }).state.status).toBe("done");
      },
      { timeout: 5000 },
    );
  }

  it("suspends at awaiting-redirect, resumes on the return leg, and confers once", async () => {
    const { app, registry } = oauthHarness();
    const { json } = await startOAuth(app);
    expect(json.state.status).toBe("awaiting-redirect");
    expect(json.state.url).toBe(AUTHORIZE_URL);
    // Nothing durable before the terminal conferral.
    expect(registry.find("github")).toHaveLength(0);

    const ret = await deliverReturn(app, { state: "st-oauth-1", handoff: "h1" });
    expect(ret.status).toBe(200);
    expect((await ret.json()) as { matched: boolean }).toMatchObject({ matched: true });

    await pollDone(app, json.cid);
    const conn = registry.find("github")[0];
    expect(conn).toBeDefined();
    const grant = await registry.getLedger().getGrant(conn.id, "user");
    expect(grant?.state).toBe("authorized");
    // Stored as the inline-custody envelope (`toPersisted`).
    expect(
      (grant?.credential as { material?: { record?: Record<string, string> } })?.material?.record,
    ).toMatchObject({ accessToken: "tok-h1" });
    expect(grant?.profile).toEqual({ login: "octocat" });
  });

  it("keeps ownership of a delivered return leg so a reload cannot reach sign-in (AC2)", async () => {
    let redeemCount = 0;
    const { app, registry } = oauthHarness({
      redeem: async (handoff) => {
        redeemCount++;
        return {
          credential: { material: { accessToken: `tok-${handoff}` }, expiresAt: "never" },
          profile: { login: "octocat" },
        };
      },
    });
    const { json } = await startOAuth(app);
    const first = await deliverReturn(app, { state: "st-oauth-1", handoff: "h1" });
    expect(first.status).toBe(200);
    await pollDone(app, json.cid);

    // A duplicate leg — the callback page is now one that stays put in the
    // system browser, so a plain reload sends the same state again. The setup
    // still owns it, so this resolves HERE rather than reading as a flow that
    // never started a setup and falling through to the sign-in redeem.
    const dup = await deliverReturn(app, { state: "st-oauth-1", handoff: "h1" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({
      matched: true,
      accepted: false,
      state: { status: "done" },
    });
    expect(redeemCount).toBe(1);
    expect(registry.find("github")).toHaveLength(1);
  });

  it("keeps ownership mid-redeem so a reload cannot race the redemption (AC2)", async () => {
    let resolveRedeem!: (v: { credential: Credential; profile?: ProfileRecord }) => void;
    let redeemCount = 0;
    const { app, registry } = oauthHarness({
      redeem: () => {
        redeemCount++;
        return new Promise((res) => {
          resolveRedeem = res;
        });
      },
    });
    const { json } = await startOAuth(app);

    // First leg resumes the coroutine into the (blocked) redeem step.
    const first = await deliverReturn(app, { state: "st-oauth-1", handoff: "h1" });
    expect(first.status).toBe(200);
    expect((await first.json()) as { state: { status: string } }).toMatchObject({
      state: { status: "presenting" },
    });

    // A second leg arriving while the coroutine is past awaiting-redirect —
    // a reload of the callback page mid-redemption. Still owned, so it is
    // reported as already-delivered rather than as an unmatched state: the
    // caller must not fall through to the sign-in redeem and race the redeem
    // that is in flight right here.
    const second = await deliverReturn(app, { state: "st-oauth-1", handoff: "h2" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      matched: true,
      accepted: false,
      state: { status: "presenting" },
    });
    expect(redeemCount).toBe(1);

    resolveRedeem({
      credential: { material: { accessToken: "tok-h1" }, expiresAt: "never" },
      profile: { login: "octocat" },
    });
    await pollDone(app, json.cid);
    expect(registry.find("github")).toHaveLength(1);
  });

  it("keeps a cancelled redirect state owned and leaves zero durable state", async () => {
    const redeem = rs.fn(async (handoff: string) => ({
      credential: { material: { accessToken: `tok-${handoff}` }, expiresAt: "never" as const },
      profile: { login: "octocat" },
    }));
    const { app, registry } = oauthHarness({ redeem });
    const { json } = await startOAuth(app);
    const cancel = await app.request(`/setups/${json.cid}/cancel`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(cancel.status).toBe(200);

    const ret = await deliverReturn(app, { state: "st-oauth-1", handoff: "h1" });
    expect(ret.status).toBe(409);
    expect(await ret.json()).toMatchObject({
      matched: true,
      accepted: false,
      state: { status: "cancelled" },
    });
    expect(redeem).not.toHaveBeenCalled();
    expect(registry.find("github")).toHaveLength(0);
  });

  it("fails the setup cleanly on a denied-consent return leg (no durable write)", async () => {
    const { app, registry } = oauthHarness();
    const { json } = await startOAuth(app);
    const ret = await deliverReturn(app, { state: "st-oauth-1", error: "access_denied" });
    expect(ret.status).toBe(200);
    const body = (await ret.json()) as { matched: boolean; state: { status: string } };
    expect(body.matched).toBe(true);
    expect(body.state.status).toBe("failed");
    // Poll confirms the terminal failed state; nothing conferred.
    const poll = await app.request(`/setups/${json.cid}`);
    expect(((await poll.json()) as { state: { status: string } }).state.status).toBe("failed");
    expect(registry.find("github")).toHaveLength(0);
  });

  it("fails the setup (no durable write) when the redeem throws", async () => {
    const { app, registry } = oauthHarness({
      redeem: async () => {
        throw new Error("OAuth redemption produced no usable credential for the grant ledger.");
      },
    });
    const { json } = await startOAuth(app);
    const ret = await deliverReturn(app, { state: "st-oauth-1", handoff: "h1" });
    // The redeem runs in a ctx.step, so the return resolves at `presenting`; the
    // failure surfaces on the next poll.
    expect(ret.status).toBe(200);
    await rs.waitFor(
      async () => {
        const poll = await app.request(`/setups/${json.cid}`);
        const state = ((await poll.json()) as { state: { status: string; reason?: string } }).state;
        expect(state.status).toBe("failed");
        expect(state.reason).toContain("no usable credential");
      },
      { timeout: 5000 },
    );
    expect(registry.find("github")).toHaveLength(0);
  });

  it("does not match a return leg for an unknown/expired state", async () => {
    const { app } = oauthHarness();
    await startOAuth(app);
    const ret = await deliverReturn(app, { state: "st-does-not-exist", handoff: "h1" });
    expect(ret.status).toBe(404);
    expect((await ret.json()) as { matched: boolean }).toMatchObject({ matched: false });
  });

  it("400s a return leg with no state", async () => {
    const { app } = oauthHarness();
    const ret = await deliverReturn(app, { handoff: "h1" });
    expect(ret.status).toBe(400);
  });

  it("blocks a cross-origin return leg", async () => {
    const { app } = oauthHarness();
    const res = await app.request("/setups/return", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "st-oauth-1", handoff: "h1" }),
    });
    expect(res.status).toBe(403);
  });
});
