// The Telegram-user descriptor. Layers under test:
//   1. material round-trip (settings ⇄ SecretRecord, incl. apiId stringify +
//      nullable username), descriptor shape, the route-driven session scheme
//      (confer throws, renew "re-confer") — pure.
//   2. fault mapping — a fake TelegramUserAdapter (rs.mock) lets us drive a
//      start rejection and a send failure; the real
//      isTelegramUserSessionRejected classifier (imported unmocked) decides
//      CredentialRejected{ grant: "session" } vs. Disconnected.
//   3. the in-epoch session probe — the fake adapter's probe()
//      throws on demand; an auth failure degrades the grant within one interval,
//      a network failure is silent, the timer dies with the epoch, and a
//      superseded epoch's late probe cannot degrade the fresh grant.
//
// The real TelegramUserAdapter builds a GramJS TelegramClient with no injectable
// transport seam (see telegram-user.test.ts), so we mock the adapter module and
// pin the descriptor's own mapping arithmetic here.

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ConversationId,
  InboundMessage,
  NormalizedMessage,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { createTestDb } from "../../test/helpers.js";
import { installTestClock } from "../../test/kit/index.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import type { Credential, ProfileRecord, SecretRecord, StreamFault, Talker } from "../types.js";
import * as telegramUserModule from "../../channels/telegram-user.js" with {
  rstest: "importActual",
};

const fakeState: {
  startError: unknown;
  sendError: unknown;
  stopped: boolean;
  sent: Array<{ channelUserId: string; threadId: string; message: OutgoingMessage }>;
  /** Error the fake probe() throws on its next tick (null → session healthy). */
  probeError: unknown;
  /** Count of probe() ticks, so a test can assert the timer stopped. */
  probeCalls: number;
  historyCalls: Array<{ threadId: string | null; windowHours: number }>;
  /** When set, probe() awaits this instead of resolving — lets a test hold a
   *  probe in flight across a re-login and release it afterward. */
  probeGate: Promise<void> | null;
} = {
  startError: null,
  sendError: null,
  stopped: false,
  sent: [],
  probeError: null,
  probeCalls: 0,
  historyCalls: [],
  probeGate: null,
};

rs.mock("../../channels/telegram-user.js", () => {
  // Keep the real classifier + error class; only replace the adapter transport.
  return {
    ...telegramUserModule,
    TelegramUserAdapter: class {
      onMessage(_handler: (msg: NormalizedMessage) => Promise<void>): void {}
      async start(): Promise<void> {
        if (fakeState.startError) throw fakeState.startError;
      }
      async stop(): Promise<void> {
        fakeState.stopped = true;
      }
      async probe(): Promise<void> {
        fakeState.probeCalls += 1;
        if (fakeState.probeGate) await fakeState.probeGate;
        if (fakeState.probeError) throw fakeState.probeError;
      }
      async sendMessage(
        channelUserId: string,
        threadId: string,
        message: OutgoingMessage,
      ): Promise<void> {
        if (fakeState.sendError) throw fakeState.sendError;
        fakeState.sent.push({ channelUserId, threadId, message });
      }
      async saveIncomingAttachments(msg: { attachments: unknown[] }): Promise<unknown[]> {
        return msg.attachments;
      }
      async fetchHistory(threadId: string | null, windowHours: number): Promise<unknown[]> {
        fakeState.historyCalls.push({ threadId, windowHours });
        return [];
      }
    },
  };
});

const { TelegramUserSessionNotAuthorizedError } = await import("../../channels/telegram-user.js");
const {
  makeTelegramUserDescriptor,
  telegramUserMaterialFromSettings,
  telegramUserProfileFromSettings,
  telegramUserSettingsFromMaterial,
} = await import("./telegram-user.js");

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SETTINGS = {
  apiId: 12345,
  apiHash: "hash-secret",
  sessionString: "sess-abc",
  phoneNumber: "+10000000000",
  userId: "u-1",
  username: "@me",
  displayName: "Me",
  connectedAt: "2026-01-01T00:00:00.000Z",
};

const validCred = () => ({
  material: telegramUserMaterialFromSettings(SETTINGS),
  expiresAt: "never" as const,
});

/** A GramJS-shaped RPC error: carries `code` and `errorMessage`. */
function rpcError(code: number | undefined, errorMessage: string): Error {
  return Object.assign(new Error(errorMessage), { code, errorMessage });
}

function buildTalker(deps: Parameters<typeof makeTelegramUserDescriptor>[0] = {}): {
  talker: Talker;
  faults: StreamFault[];
  start: () => void;
} {
  const desc = makeTelegramUserDescriptor(deps);
  const talker = desc.capabilities.talker!.build(
    { session: validCred() },
    {
      connectionId: "telegram-user-test",
      persist: async () => {},
      registerIngress: () => () => {},
    },
  );
  const faults: StreamFault[] = [];
  return {
    talker,
    faults,
    start: () =>
      talker.start(
        () => {},
        (err) => faults.push(err),
      ),
  };
}

beforeEach(() => {
  fakeState.startError = null;
  fakeState.sendError = null;
  fakeState.stopped = false;
  fakeState.sent = [];
  fakeState.probeError = null;
  fakeState.probeCalls = 0;
  fakeState.historyCalls = [];
  fakeState.probeGate = null;
});

describe("telegram_user material round-trip", () => {
  it("serializes settings to a flat SecretRecord and back losslessly", () => {
    const material = telegramUserMaterialFromSettings(SETTINGS);
    expect(material.apiId).toBe("12345"); // stringified
    expect(material.username).toBe("@me");
    expect(telegramUserSettingsFromMaterial(material)).toEqual(SETTINGS);
  });

  it("round-trips a null username through the empty string", () => {
    const material = telegramUserMaterialFromSettings({ ...SETTINGS, username: null });
    expect(material.username).toBe("");
    expect(telegramUserSettingsFromMaterial(material).username).toBeNull();
  });
});

describe("telegram_user descriptor shape", () => {
  it("declares one setup-driven `session` grant and a talker needing it", () => {
    const desc = makeTelegramUserDescriptor();
    expect(desc.service).toBe("telegram_user");
    expect(Object.keys(desc.auth)).toEqual(["session"]);
    expect(desc.capabilities.talker?.needs).toEqual(["session"]);
    expect(desc.capabilities.actor).toBeUndefined();
    // The `session` grant carries a conferral setup coroutine.
    expect(typeof desc.auth.session.setup).toBe("function");
  });

  it("session scheme: confer is setup-driven (throws), renew answers re-confer", async () => {
    const scheme = makeTelegramUserDescriptor().auth.session;
    await expect(scheme.confer({ prompt: async () => ({}) })).rejects.toThrow(
      "conferral driven by the connection setup",
    );
    expect(await scheme.renew({ material: {} as SecretRecord, expiresAt: "never" })).toBe(
      "re-confer",
    );
  });

  it("exposes inbound media and returns an awaitable stop()", async () => {
    const h = buildTalker();
    h.start();
    const message = {
      messageId: "message-1",
      conversationId: "dialog-1" as ConversationId,
      senderId: "999",
      text: "hi",
      attachments: [],
      timestamp: new Date(),
      raw: { channel: "telegram_user", rawEvent: null, attachments: [] },
    } satisfies InboundMessage;
    await expect(h.talker.feature("inboundMedia")?.materialize(message)).resolves.toEqual([]);
    const stopped = h.talker.stop();
    expect(stopped).toBeInstanceOf(Promise);
    await stopped;
    expect(fakeState.stopped).toBe(true);
  });

  it("exposes provider-neutral history", async () => {
    const h = buildTalker();
    h.start();
    await expect(
      h.talker.feature("history")?.query({
        conversationId: "dialog-1" as ConversationId,
        limit: 20,
      }),
    ).resolves.toEqual([]);
    expect(fakeState.historyCalls).toEqual([{ threadId: "dialog-1", windowHours: 24 }]);
  });
});

describe("telegram_user Talker fault mapping", () => {
  it("maps a not-authorized session at start to CredentialRejected{ grant: 'session' }", async () => {
    const h = buildTalker();
    fakeState.startError = new TelegramUserSessionNotAuthorizedError();
    h.start();
    await flush();
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("session");
  });

  it("maps a 401 at start to CredentialRejected{ grant: 'session' }", async () => {
    const h = buildTalker();
    fakeState.startError = rpcError(401, "UNAUTHORIZED");
    h.start();
    await flush();
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("session");
  });

  it("maps an AUTH_KEY_UNREGISTERED RPC error to CredentialRejected", async () => {
    const h = buildTalker();
    fakeState.startError = rpcError(undefined, "AUTH_KEY_UNREGISTERED");
    h.start();
    await flush();
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("session");
  });

  it("maps a generic transport failure at start to Disconnected", async () => {
    const h = buildTalker();
    fakeState.startError = new Error("ECONNRESET");
    h.start();
    await flush();
    expect(h.faults[0]).toBeInstanceOf(Disconnected);
    expect(h.faults[0]).not.toBeInstanceOf(CredentialRejected);
  });

  it("throws CredentialRejected{ grant: 'session' } from send() on a session revocation", async () => {
    const h = buildTalker();
    h.start();
    fakeState.sendError = rpcError(undefined, "SESSION_REVOKED");
    const address = "999" as ConversationId;
    await expect(h.talker.send(address, { text: "hi" })).rejects.toBeInstanceOf(CredentialRejected);
    await expect(h.talker.send(address, { text: "hi" })).rejects.toMatchObject({
      grant: "session",
    });
  });

  it("rethrows a non-auth send() failure unchanged (not a credential fault)", async () => {
    const h = buildTalker();
    h.start();
    fakeState.sendError = new Error("timeout");
    await expect(h.talker.send("999" as ConversationId, { text: "hi" })).rejects.toThrow("timeout");
  });

  it("forwards the opaque conversation id to the adapter's sendMessage", async () => {
    const h = buildTalker();
    h.start();
    await h.talker.send("chat-42" as ConversationId, { text: "hi" });
    expect(fakeState.sent).toEqual([
      { channelUserId: "chat-42", threadId: "chat-42", message: { text: "hi" } },
    ]);
  });
});

describe("telegram_user in-epoch session probe", () => {
  it("reports a revoked session (auth failure) as CredentialRejected on the next probe", async () => {
    const clock = installTestClock();
    try {
      const h = buildTalker({ probeIntervalMs: 1000 });
      h.start();
      fakeState.probeError = rpcError(401, "UNAUTHORIZED");
      await clock.advance(1000); // one probe interval
      expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
      expect((h.faults[0] as CredentialRejected).grant).toBe("session");
    } finally {
      clock.uninstall();
    }
  });

  it("does NOT treat a network failure during a probe as a fault", async () => {
    const clock = installTestClock();
    try {
      const h = buildTalker({ probeIntervalMs: 1000 });
      h.start();
      fakeState.probeError = new Error("ECONNRESET");
      await clock.advance(3000); // three probe intervals, all network failures
      expect(fakeState.probeCalls).toBeGreaterThanOrEqual(1);
      expect(h.faults).toHaveLength(0);
    } finally {
      clock.uninstall();
    }
  });

  it("stops probing once the epoch is stopped (the timer dies with the epoch)", async () => {
    const clock = installTestClock();
    try {
      const h = buildTalker({ probeIntervalMs: 1000 });
      h.start();
      await clock.advance(1000);
      const callsAfterOne = fakeState.probeCalls;
      expect(callsAfterOne).toBeGreaterThanOrEqual(1);
      await h.talker.stop();
      await clock.advance(5000);
      expect(fakeState.probeCalls).toBe(callsAfterOne);
    } finally {
      clock.uninstall();
    }
  });

  it("never runs probes concurrently: ticks are skipped while one is in flight on a stalled client", async () => {
    const clock = installTestClock();
    try {
      const h = buildTalker({ probeIntervalMs: 1000 });
      h.start();
      // The client stalls: the first probe parks and outlives several intervals.
      let releaseProbe!: () => void;
      fakeState.probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      await clock.advance(1000); // tick 1: probe starts, parks
      expect(fakeState.probeCalls).toBe(1);
      await clock.advance(3000); // ticks 2–4: skipped, nothing stacks on the socket
      expect(fakeState.probeCalls).toBe(1);

      // The stalled probe settles; the next tick probes again.
      fakeState.probeGate = null;
      releaseProbe();
      await clock.advance(0);
      await clock.advance(1000);
      expect(fakeState.probeCalls).toBe(2);
    } finally {
      clock.uninstall();
    }
  });
});

// The probe wired through a REAL ConnectionRegistry over a drizzle ledger: the
// end-to-end grant-degradation behavior.
const PROFILE = telegramUserProfileFromSettings(SETTINGS) as ProfileRecord;

function makeRegistry(): ConnectionRegistry {
  const { db } = createTestDb();
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
  registry.register(makeTelegramUserDescriptor({ probeIntervalMs: 1000 }));
  return registry;
}

describe("telegram_user probe → grant degradation (registry)", () => {
  it("degrades the session grant within one probe interval when the session is remotely terminated", async () => {
    const clock = installTestClock();
    try {
      const registry = makeRegistry();
      const conn = await registry.connect("telegram_user");
      await registry.importCredential(conn.id, "session", validCred() as Credential, PROFILE);
      expect(conn.auth.grants().session).toBe("authorized");
      expect(conn.talk).not.toBeNull();

      // The account revokes the session server-side: the next probe sees it.
      fakeState.probeError = rpcError(undefined, "SESSION_REVOKED");
      await clock.advance(1000);

      // renew answers "re-confer", so one probe fault degrades. The status
      // surface then reads needs-reconnect + reason off the ledger.
      expect(conn.auth.grants().session).toBe("degraded");
      expect(conn.talk).toBeNull();
      const grant = await registry.getLedger().getGrant(conn.id, "session");
      expect(grant?.state).toBe("degraded");
      // The status surface reads `degradedReason` off this — a non-empty reason
      // naming the credential rejection (the registry's renew-once-then-degrade
      // wording; a user session's renew can only answer "re-confer").
      expect(grant?.degraded?.reason).toContain("credential rejected");
      expect(grant?.degraded?.at).toBeInstanceOf(Date);
    } finally {
      clock.uninstall();
    }
  });

  it("drops a superseded epoch's probe fault: a re-login mid-probe keeps the fresh grant authorized", async () => {
    const clock = installTestClock();
    try {
      const registry = makeRegistry();
      const conn = await registry.connect("telegram_user");
      await registry.importCredential(conn.id, "session", validCred() as Credential, PROFILE);

      // Park epoch A's probe in flight (it has read the live client but not yet
      // returned) so a re-login can land underneath it.
      let releaseProbe!: () => void;
      fakeState.probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      await clock.advance(1000); // epoch A's probe tick, now parked on the gate
      expect(fakeState.probeCalls).toBeGreaterThanOrEqual(1);

      // A fresh login completes: a NEW session credential rebuilds the epoch.
      fakeState.probeGate = null; // epoch B probes resolve normally
      const cred2: Credential = {
        material: telegramUserMaterialFromSettings({
          ...SETTINGS,
          sessionString: "sess-fresh",
          connectedAt: "2026-02-02T00:00:00.000Z",
        }),
        expiresAt: "never",
      };
      await registry.importCredential(conn.id, "session", cred2, PROFILE);
      expect(conn.auth.grants().session).toBe("authorized");

      // Epoch A's parked probe now fails auth — but it reports through the dead
      // epoch's fault callback, so the registry drops it. No 1000ms is advanced,
      // so epoch B never probes.
      fakeState.probeError = rpcError(undefined, "SESSION_REVOKED");
      releaseProbe();
      await clock.advance(0);
      await clock.advance(0);

      expect(conn.auth.grants().session).toBe("authorized");
      expect(conn.talk).not.toBeNull();
    } finally {
      clock.uninstall();
    }
  });
});
