// The Email conferral setup, driven through the real
// SetupSession runtime and, end-to-end, through the generic setup routes over a
// real ConnectionRegistry (no network: fake MailProvider).
//
// Seams under test:
//   1. makeEmailSetup's coroutine — show progress → `ctx.step("provision")` →
//      pure-config settings write → terminal conferral — observed via the
//      session's poll-able state and the single commit call.
//   2. The cutover surface — enable via POST
//      /connections/email/grants/inbox/setup + poll, tear down via the
//      registry-native DELETE /connections/:id/grants/inbox — including the
//      lifecycle rule that `guardianEmail` config survives revoke.

import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { connectionsRoutes } from "../../api/routes/connections.js";
import { setupsRoutes } from "../../api/routes/setups.js";
import type { ApiDeps } from "../../api/deps.js";
import { SettingsRepository } from "../../db/repositories/settings.js";
import { createTestDb } from "../../test/helpers.js";
import type { MailProvider, RomeMailEvent, RomeMailMessage } from "../../lib/rome-cloud-mail.js";
import { ConnectionRegistry } from "../registry.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { SetupManager } from "../setup/manager.js";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import { makeEmailDescriptor, makeEmailSetup } from "./email.js";

const EMAIL_ADDRESS = "slug@mail.romeos.cc";
const EMAIL_SECRET = "setup-inbound-secret";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** In-memory settings store shaped like the SettingsRepository surface the
 *  setup consumes. */
function makeSettingsStore(initial?: Record<string, unknown>) {
  const values = new Map<string, unknown>();
  if (initial) values.set("email", initial);
  return {
    values,
    repo: {
      get: async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
      set: async (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
      },
    },
  };
}

describe("makeEmailSetup (coroutine)", () => {
  it("shows provisioning progress, then confers the provisioned coordinates + email profile", async () => {
    const provision = deferred<{ address: string; inboundSecret: string }>();
    const { values, repo } = makeSettingsStore();
    const fn = makeEmailSetup({ provision: () => provision.promise, settings: repo });
    let rowAtCommit: unknown;
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {
      rowAtCommit = values.get("email");
    });
    const session = new SetupSession({ fn, commit });

    await session.started();
    // The park while provision is in flight renders the progress view.
    expect(session.state.status).toBe("presenting");
    if (session.state.status === "presenting") {
      expect(session.state.view.progress).toBe(true);
    }

    provision.resolve({ address: EMAIL_ADDRESS, inboundSecret: EMAIL_SECRET });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toEqual({
      credential: {
        material: { address: EMAIL_ADDRESS, inboundSecret: EMAIL_SECRET },
        expiresAt: "never",
      },
      profile: { address: EMAIL_ADDRESS },
      summary: {
        title: "Email connected",
        body: [`Your agent's address is ${EMAIL_ADDRESS}.`],
      },
    });

    // The settings row is pure config, and it landed BEFORE the conferral (the
    // row the fresh adapter epoch reads at start()).
    expect(rowAtCommit).toEqual({ enabled: true });
    expect(values.get("email")).toEqual({ enabled: true });
  });

  it("preserves guardianEmail config and strips stale legacy credential fields from the row", async () => {
    const { values, repo } = makeSettingsStore({
      enabled: false,
      guardianEmail: "g@example.com",
      // A pre-4c row could still carry credential fields; the setup's config
      // write must not let them survive.
      address: "stale@mail.romeos.cc",
      inboundSecret: "stale-secret",
    });
    const fn = makeEmailSetup({
      provision: async () => ({ address: EMAIL_ADDRESS, inboundSecret: EMAIL_SECRET }),
      settings: repo,
    });
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    expect(values.get("email")).toEqual({ enabled: true, guardianEmail: "g@example.com" });
  });

  it("fails the setup on a provision error — no config write, no commit", async () => {
    const { values, repo } = makeSettingsStore();
    const fn = makeEmailSetup({
      provision: async () => {
        throw new Error("could not reach Rome Cloud mail API: ECONNRESET");
      },
      settings: repo,
    });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });
    await session.started();

    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    expect(session.state).toEqual({
      status: "failed",
      reason: "could not reach Rome Cloud mail API: ECONNRESET",
    });
    expect(commit).not.toHaveBeenCalled();
    expect(values.has("email")).toBe(false);
  });

  it("cancel interrupts an in-flight provision — cancelled, zero durable state", async () => {
    const provision = deferred<{ address: string; inboundSecret: string }>();
    const { values, repo } = makeSettingsStore();
    const fn = makeEmailSetup({ provision: () => provision.promise, settings: repo });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });
    await session.started();

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    expect(values.has("email")).toBe(false);
  });
});

// End-to-end over the generic routes (real registry, drizzle ledger, fake mail)

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

function makeMailProvider(provisionMock: ReturnType<typeof rs.fn>): MailProvider {
  return {
    provision: provisionMock as unknown as MailProvider["provision"],
    send: async () => ({ messageId: "m_out", threadId: "t_out" }),
    getMessage: async (id: string): Promise<RomeMailMessage> => ({
      id,
      threadId: "t1",
      receivedAt: new Date(0).toISOString(),
      body: { markdown: "hello from the full body" },
      attachments: [],
      hasAttachment: false,
      provider: "agentmail",
      providerMessageId: id,
      mailboxAddress: EMAIL_ADDRESS,
      direction: "inbound",
      authentication: { authenticated: true, spam: false, blocked: false },
      labels: [],
    }),
    getAttachment: async () => ({
      downloadUrl: "https://example.com/x",
      expiresAt: new Date(0).toISOString(),
      size: 0,
    }),
    listMessages: async () => ({ messages: [], nextPageToken: undefined }),
  };
}

function emailEvent(): RomeMailEvent {
  return {
    type: "message.received",
    provider: "agentmail",
    mailboxAddress: EMAIL_ADDRESS,
    id: "evt_1",
    providerMessageId: "msg_1",
    threadId: "t1",
    from: [{ name: "Guardian", email: "guardian@example.com" }],
    to: [{ email: EMAIL_ADDRESS }],
    subject: "Hi",
    preview: "preview text",
    receivedAt: new Date(0).toISOString(),
    hasAttachment: false,
    attachments: [],
    authentication: { authenticated: true, spam: false, blocked: false },
    labels: ["received", "unread"],
  };
}

function signEmail(raw: string): string {
  return createHmac("sha256", EMAIL_SECRET).update(raw).digest("hex");
}

const openTestDbs: Array<() => void> = [];
afterEach(() => {
  while (openTestDbs.length > 0) openTestDbs.pop()?.();
});

function makeSetupApp() {
  const { db: testDb, close } = createTestDb();
  openTestDbs.push(close);
  const settingsRepo = new SettingsRepository(testDb);
  const provisionMock = rs.fn(async () => ({
    address: EMAIL_ADDRESS,
    inboundSecret: EMAIL_SECRET,
  }));
  // Fault injection at the persistence seam: while armed, the ledger's
  // writeGrant (the credential write inside `confer`'s terminal transaction)
  // throws, so the whole conferral transaction rolls back AFTER provisioning
  // succeeded — the placeholder mint reverts with it.
  let grantWriteFailures = 0;
  const realLedger = new DrizzleGrantLedger(testDb);
  const ledger = new Proxy(realLedger, {
    get(target, prop, receiver) {
      if (prop === "writeGrant") {
        return (...args: Parameters<DrizzleGrantLedger["writeGrant"]>) => {
          if (grantWriteFailures > 0) {
            grantWriteFailures--;
            throw new Error("ledger write failed (injected)");
          }
          return target.writeGrant(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const registry = new ConnectionRegistry({ ledger });
  const personMappingRepo = {
    findByChannelUser: async () => null,
    findByBondLevel: async () => [],
    deleteGuardianChannelMappings: rs.fn(),
  } as unknown as ApiDeps["personMappingRepo"];
  registry.register(
    makeEmailDescriptor({
      provider: makeMailProvider(provisionMock),
      settingsRepo,
      personMappingRepo,
      ownerEmailResolver: async () => undefined,
    }),
  );
  const setupManager = new SetupManager({ registry, personMappingRepo });
  const deps = {
    settingsRepo,
    connectionRegistry: registry,
    setupManager,
    db: testDb,
    personMappingRepo,
  } as unknown as ApiDeps;
  const app = new Hono().route("/", setupsRoutes(deps)).route("/", connectionsRoutes(deps));
  return {
    app,
    registry,
    settingsRepo,
    provisionMock,
    failNextGrantWrite: () => grantWriteFailures++,
  };
}

/** Start (or restart) the email setup and poll it to a terminal state. */
async function runSetup(app: Hono, idOrService = "email") {
  const started = await app.request(`/connections/${idOrService}/grants/inbox/setup`, {
    method: "POST",
    headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(started.status).toBe(200);
  const { cid } = (await started.json()) as { cid: string };
  let state: { status: string; reason?: string } = { status: "unknown" };
  await rs.waitFor(async () => {
    const res = await app.request(`/setups/${cid}`);
    expect(res.status).toBe(200);
    ({ state } = (await res.json()) as { state: { status: string; reason?: string } });
    expect(["done", "failed", "cancelled"]).toContain(state.status);
  });
  return { cid, state };
}

describe("Email cutover — generic setup routes + registry-native teardown", () => {
  it("enables end-to-end: provisions, confers the inbox grant, unlocks Talk, delivers signed mail — no credential in settings", async () => {
    const { app, registry, settingsRepo, provisionMock } = makeSetupApp();

    const { state } = await runSetup(app);
    expect(state.status).toBe("done");
    expect(provisionMock).toHaveBeenCalledTimes(1);

    const conn = registry.find("email")[0];
    expect(conn.auth.grants().inbox).toBe("authorized");
    expect(conn.talk).not.toBeNull();

    // The provisioned address renders from the grant profile.
    const list = await app.request("/connections");
    const { connections } = (await list.json()) as {
      connections: Array<{ service: string; display: Record<string, { email: string | null }> }>;
    };
    const email = connections.find((c) => c.service === "email");
    expect(email?.display.inbox?.email).toBe(EMAIL_ADDRESS);

    // The settings row is pure config — no credential fields ever landed there.
    expect(await settingsRepo.get("email")).toEqual({ enabled: true });

    // Hello mail: a signed inbound deposit dispatches through the live Talk.
    const received: unknown[] = [];
    conn.talk!.subscribe(async (m) => {
      received.push(m);
      return;
    });
    const raw = JSON.stringify(emailEvent());
    const result = (await registry.ingest(conn.id, {
      rawBody: raw,
      signature: signEmail(raw),
    })) as { status: string };
    expect(result.status).toBe("dispatched");
    expect(received).toHaveLength(1);
  });

  it("registry-native DELETE tears down the grant while guardianEmail config survives; a fresh setup re-provisions", async () => {
    const { app, registry, settingsRepo, provisionMock } = makeSetupApp();
    // A configured guardian address predates the connect (e.g. adapter
    // self-heal) — the lifecycle rule says it must ride out revoke.
    await settingsRepo.set("email", { enabled: true, guardianEmail: "g@example.com" });

    await runSetup(app);
    const conn = registry.find("email")[0];
    expect(conn.auth.grants().inbox).toBe("authorized");

    const del = await app.request(`/connections/${conn.id}/grants/inbox`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(del.status).toBe(200);
    expect(conn.auth.grants().inbox).toBe("unauthorized");
    expect(conn.talk).toBeNull();
    // guardianEmail rides the settings row, which the teardown never touches.
    expect(await settingsRepo.get("email")).toEqual({
      enabled: true,
      guardianEmail: "g@example.com",
    });

    // Re-enable → provision runs AGAIN → a fresh working inbox on the SAME row.
    const { state } = await runSetup(app, conn.id);
    expect(state.status).toBe("done");
    expect(provisionMock).toHaveBeenCalledTimes(2);
    expect(registry.find("email")).toHaveLength(1);
    expect(conn.auth.grants().inbox).toBe("authorized");
    expect(conn.talk).not.toBeNull();
  });

  it("a failed conferral fails the setup (grant stays unauthorized); a retry converges", async () => {
    const { app, registry, failNextGrantWrite } = makeSetupApp();

    failNextGrantWrite();
    const failed = await runSetup(app);
    expect(failed.state.status).toBe("failed");
    const conn = registry.find("email")[0];
    expect(conn?.auth.grants().inbox ?? "unauthorized").toBe("unauthorized");
    expect(conn?.talk ?? null).toBeNull();

    // The failed setup is terminal, so the next start begins fresh and lands.
    const retried = await runSetup(app);
    expect(retried.state.status).toBe("done");
    const after = registry.find("email")[0];
    expect(after.auth.grants().inbox).toBe("authorized");
    expect(after.talk).not.toBeNull();
  });
});
