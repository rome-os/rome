// The WhatsApp setup, driven through the real SetupSession
// runtime with an injected pairing-socket fake (no Baileys, no network).
//
// Seams under test:
//   1. makeWhatsAppSetup's coroutine — transient socket → show(each QR) →
//      "paired" wait → terminal grant of the
//      in-memory session material + whatsapp profile — observed via the
//      session's poll-able state and the single commit call.
//   2. Zero-durable-state teardown: cancel/fault stops the transient socket and
//      never commits.
//   3. Discovery (ported from the retired whatsappPairingState() tracker test):
//      an in-flight pairing setup is reported as the grant's active setup
//      through the generic SetupManager surface.

import { describe, expect, it, rs } from "@rstest/core";
import type { PeopleRepository } from "../../db/repositories/people.js";
import { SetupManager, type SetupRegistry } from "../setup/manager.js";
import { SetupSession } from "../setup/session.js";
import type { SetupGrant } from "../setup/types.js";
import type { Connection } from "../types.js";
import {
  createWhatsAppDescriptor,
  makeWhatsAppSetup,
  type WhatsAppPairingHandle,
} from "./whatsapp.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePairingFake(paired: Promise<string>) {
  let qrSink: ((qr: string) => void) | undefined;
  const handle = {
    start: rs.fn(async () => {}),
    onQr: rs.fn((callback: (qr: string) => void) => {
      qrSink = callback;
    }),
    waitForPaired: rs.fn(() => paired),
    serialize: rs.fn(() => ({ creds: "serialized-creds", keys: "serialized-keys" })),
    stop: rs.fn(async () => {}),
  } satisfies WhatsAppPairingHandle;
  return Object.assign(handle, { emitQr: (qr: string) => qrSink?.(qr) });
}

const fakeQrDataUrl = async (content: string) => `data:image/png;base64,${content}`;

function presentedView(session: SetupSession) {
  const state = session.state;
  if (state.status !== "presenting") throw new Error(`not presenting: ${state.status}`);
  return state.view;
}

describe("makeWhatsAppSetup", () => {
  it("shows each rotating QR, then grants on link", async () => {
    const link = deferred<string>();
    const pairing = makePairingFake(link.promise);
    const fn = makeWhatsAppSetup({ openPairing: () => pairing, makeQrDataUrl: fakeQrDataUrl });
    const commit = rs.fn(async (_c: SetupGrant, _s: AbortSignal) => {});
    const session = new SetupSession({ fn, commit });

    // No form: the setup goes straight to a working view while the socket starts.
    await session.started();
    expect(session.state.status).toBe("presenting");
    await rs.waitFor(() => expect(pairing.start).toHaveBeenCalled());
    expect(presentedView(session).qr).toBeUndefined();

    // Each QR WhatsApp issues is server-rendered into the view as a data URL.
    pairing.emitQr("qr-1");
    await rs.waitFor(() => expect(presentedView(session).qr).toBe("data:image/png;base64,qr-1"));
    expect(presentedView(session).progress).toBe(true);
    expect(presentedView(session).steps?.length).toBeGreaterThan(0);

    pairing.emitQr("qr-2");
    await rs.waitFor(() => expect(presentedView(session).qr).toBe("data:image/png;base64,qr-2"));

    link.resolve("14155550134@s.whatsapp.net");
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    // The transient socket is stopped BEFORE the grant commit (WhatsApp
    // allows one live socket per session; the registry builds the real Talker).
    expect(pairing.stop).toHaveBeenCalledTimes(1);
    expect(pairing.stop.mock.invocationCallOrder[0]).toBeLessThan(
      commit.mock.invocationCallOrder[0],
    );

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toEqual({
      credential: {
        material: { creds: "serialized-creds", keys: "serialized-keys" },
        expiresAt: "never",
      },
      profile: { phoneNumber: "14155550134", jid: "14155550134@s.whatsapp.net" },
      guardianChannelUserId: "14155550134@s.whatsapp.net",
      summary: {
        title: "WhatsApp connected",
        body: ["+14155550134 is linked and your account is mapped as guardian."],
      },
    });
  });

  it("cancel mid-pairing-wait stops the transient socket and runs no commit", async () => {
    const pairing = makePairingFake(new Promise<string>(() => {}));
    const fn = makeWhatsAppSetup({ openPairing: () => pairing, makeQrDataUrl: fakeQrDataUrl });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await rs.waitFor(() => expect(pairing.waitForPaired).toHaveBeenCalled());

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    await rs.waitFor(() => expect(pairing.stop).toHaveBeenCalled());
  });

  it("fails the setup and stops the socket when the pairing handshake faults", async () => {
    const link = deferred<string>();
    const pairing = makePairingFake(link.promise);
    const fn = makeWhatsAppSetup({ openPairing: () => pairing, makeQrDataUrl: fakeQrDataUrl });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await rs.waitFor(() => expect(pairing.waitForPaired).toHaveBeenCalled());

    link.reject(new Error("WhatsApp connection failed during pairing."));
    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    if (session.state.status === "failed") {
      expect(session.state.reason).toBe("WhatsApp connection failed during pairing.");
    }
    expect(commit).not.toHaveBeenCalled();
    await rs.waitFor(() => expect(pairing.stop).toHaveBeenCalled());
  });
});

// Ported from the retired route-owned tracker test ("reports an active
// first-time pairing attempt"): re-attach/discovery is the generic protocol's
// job now, so an in-flight pairing setup must be reported as the grant's
// active setup.
describe("WhatsApp setup discovery", () => {
  function makeRegistry(): SetupRegistry {
    const descriptor = createWhatsAppDescriptor({
      syncSink: { upsertContacts: rs.fn(), upsertChats: rs.fn(), insertMessages: rs.fn() } as never,
      onGuardianConnected: () => {},
      openPairing: () => makePairingFake(new Promise<string>(() => {})),
    });
    return {
      getDescriptor: (connectionKind) => (connectionKind === "whatsapp" ? descriptor : null),
      withGrantSection: (_s, _g, fn) => fn(),
      // Never reached: the discovery test parks the pairing promise unresolved,
      // so the setup never grants. Present only to satisfy SetupRegistry.
      giveGrant: async () => ({ id: "conn-wa" }) as unknown as Connection,
    };
  }

  it("reports an in-flight pairing setup as the session grant's active setup", async () => {
    const manager = new SetupManager({
      registry: makeRegistry(),
      peopleRepo: {} as PeopleRepository,
    });

    const started = await manager.start({ connectionKind: "whatsapp" }, "session");
    expect(started.reattached).toBe(false);
    // The pairing attempt is in flight at once, and discoverable at its state.
    expect(manager.activeFor("whatsapp", "session")).toBe(started.cid);
    expect(manager.state(started.cid)?.status).toBe("presenting");

    // A duplicate start re-attaches instead of spawning a second socket.
    const again = await manager.start({ connectionKind: "whatsapp" }, "session");
    expect(again.reattached).toBe(true);
    expect(again.cid).toBe(started.cid);
  });
});
