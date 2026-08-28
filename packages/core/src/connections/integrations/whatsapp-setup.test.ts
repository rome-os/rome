// The WhatsApp conferral setup, driven through the real SetupSession
// runtime with an injected pairing-socket fake (no Baileys, no network).
//
// Seams under test:
//   1. makeWhatsAppSetup's coroutine — prompt(phoneNumber) → transient socket +
//      pairing code → show(code) → "paired" wait → terminal conferral of the
//      in-memory session material + whatsapp profile — observed via the
//      session's poll-able state and the single commit call.
//   2. Zero-durable-state teardown: cancel/fault stops the transient socket and
//      never commits.
//   3. Discovery (ported from the retired whatsappPairingState() tracker test):
//      an in-flight pairing setup is reported as the grant's active setup
//      through the generic SetupManager surface.

import { describe, expect, it, rs } from "@rstest/core";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { SetupManager, type SetupRegistry } from "../setup/manager.js";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
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
  const handle = {
    start: rs.fn(async () => {}),
    requestPairingCode: rs.fn(async () => "ABCD1234"),
    waitForPaired: rs.fn(() => paired),
    serialize: rs.fn(() => ({ creds: "serialized-creds", keys: "serialized-keys" })),
    stop: rs.fn(async () => {}),
  } satisfies WhatsAppPairingHandle;
  return handle;
}

describe("makeWhatsAppSetup", () => {
  it("prompts the phone number, shows the pairing code, then confers on link", async () => {
    const link = deferred<string>();
    const pairing = makePairingFake(link.promise);
    const openPairing = rs.fn(() => pairing);
    const fn = makeWhatsAppSetup({ openPairing });
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    expect(session.state.status).toBe("awaiting-input");
    // The socket only spins up once the guardian has supplied a number.
    expect(openPairing).not.toHaveBeenCalled();

    const afterInput = await session.provideInput({ phoneNumber: "+1 (415) 555-0134" });
    // The number is normalized to digits before it reaches the socket.
    await rs.waitFor(() => expect(pairing.requestPairingCode).toHaveBeenCalledWith("14155550134"));
    await rs.waitFor(() => expect(session.state.status).toBe("presenting"));
    expect(afterInput.state.status).toBe("presenting");

    // The pairing code is server-authored into the view payload (formatted for
    // reading) so the standard renderer shows it without WhatsApp knowledge.
    await rs.waitFor(() => {
      const state = session.state;
      if (state.status !== "presenting") throw new Error("not presenting");
      expect(state.view.body).toContain("ABCD-1234");
      expect(state.view.progress).toBe(true);
      expect(state.view.steps?.length).toBeGreaterThan(0);
    });

    link.resolve("14155550134@s.whatsapp.net");
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    // The transient socket is stopped BEFORE the conferral commit (WhatsApp
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

  it("re-prompts with the error on an invalid phone number", async () => {
    const openPairing = rs.fn(() => makePairingFake(new Promise<string>(() => {})));
    const fn = makeWhatsAppSetup({ openPairing });
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();

    const rejected = await session.provideInput({ phoneNumber: "123" });
    expect(rejected.state.status).toBe("awaiting-input");
    if (rejected.state.status === "awaiting-input") {
      expect(rejected.state.error).toBe("Invalid phone number. Use country code + digits only.");
    }
    expect(openPairing).not.toHaveBeenCalled();

    const accepted = await session.provideInput({ phoneNumber: "14155550134" });
    expect(accepted.state.status).toBe("presenting");
    expect(openPairing).toHaveBeenCalledTimes(1);
  });

  it("cancel mid-pairing-wait stops the transient socket and runs no commit", async () => {
    const pairing = makePairingFake(new Promise<string>(() => {}));
    const fn = makeWhatsAppSetup({ openPairing: () => pairing });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await session.provideInput({ phoneNumber: "14155550134" });
    await rs.waitFor(() => expect(pairing.waitForPaired).toHaveBeenCalled());

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    await rs.waitFor(() => expect(pairing.stop).toHaveBeenCalled());
  });

  it("fails the setup and stops the socket when the pairing handshake faults", async () => {
    const link = deferred<string>();
    const pairing = makePairingFake(link.promise);
    const fn = makeWhatsAppSetup({ openPairing: () => pairing });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await session.provideInput({ phoneNumber: "14155550134" });
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
      getDescriptor: (service) => (service === "whatsapp" ? descriptor : null),
      withGrantSection: (_s, _g, fn) => fn(),
      // Never reached: the discovery test parks the pairing promise unresolved,
      // so the setup never confers. Present only to satisfy SetupRegistry.
      confer: async () => ({ id: "conn-wa" }) as unknown as Connection,
    };
  }

  it("reports an in-flight pairing setup as the session grant's active setup", async () => {
    const manager = new SetupManager({
      registry: makeRegistry(),
      personMappingRepo: {} as PersonMappingRepository,
    });

    const started = await manager.start({ service: "whatsapp" }, "session");
    expect(started.reattached).toBe(false);
    expect(started.state.status).toBe("awaiting-input");
    expect(manager.activeFor("whatsapp", "session")).toBe(started.cid);

    // Feed the number: the setup advances to presenting (the pairing attempt is
    // now in flight) and stays discoverable at its current state.
    await manager.provideInput(started.cid, { phoneNumber: "14155550134" });
    expect(manager.activeFor("whatsapp", "session")).toBe(started.cid);
    expect(manager.state(started.cid)?.status).toBe("presenting");

    // A duplicate start re-attaches instead of spawning a second socket.
    const again = await manager.start({ service: "whatsapp" }, "session");
    expect(again.reattached).toBe(true);
    expect(again.cid).toBe(started.cid);
  });
});
