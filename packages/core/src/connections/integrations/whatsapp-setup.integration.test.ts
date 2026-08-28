// Black-box regression for the generic WhatsApp setup surface.
//
// The test drives only HTTP and observes only setup states. Everything Rome
// owns is real: Hono routes, SetupManager/SetupSession, the WhatsApp setup
// coroutine, and WhatsAppAdapter. The sole fake is the external WhatsApp socket
// boundary. It models the reported failure: requesting a code before the
// registration-ready QR event returns a locally generated code, then closes
// with 401. The public setup must wait for readiness and remain presenting.

import { Hono } from "hono";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { setupsRoutes } from "../../api/routes/setups.js";
import type { ApiDeps } from "../../api/deps.js";
import { WhatsAppAdapter, type WhatsAppSocketFactory } from "../../channels/whatsapp.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { createTestDb } from "../../test/helpers.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import { SetupManager } from "../setup/manager.js";
import type { SetupState } from "../setup/types.js";
import { createWhatsAppDescriptor } from "./whatsapp.js";

const SAME_ORIGIN = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

interface FakeWhatsAppSocket {
  ready: boolean;
  emit(event: string, payload: unknown): void;
}

function fakeSocketFactory(controls: FakeWhatsAppSocket[]): WhatsAppSocketFactory {
  return (() => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const control: FakeWhatsAppSocket = {
      ready: false,
      emit(event, payload) {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
    };
    controls.push(control);

    return {
      ev: {
        on(event: string, handler: (payload: unknown) => void) {
          const listeners = handlers.get(event) ?? [];
          listeners.push(handler);
          handlers.set(event, listeners);
        },
      },
      requestPairingCode: async () => {
        if (!control.ready) {
          // Baileys can return its locally generated code before WhatsApp has
          // accepted the companion-registration state. Reproduce the observed
          // follow-up rejection at the external socket boundary.
          setTimeout(() => {
            control.emit("connection.update", {
              connection: "close",
              lastDisconnect: {
                error: {
                  message: "Connection Failure",
                  output: { statusCode: 401 },
                },
              },
            });
          }, 0);
        }
        return "ABCD1234";
      },
      end: rs.fn(),
      sendMessage: rs.fn(),
      user: undefined,
    };
  }) as unknown as WhatsAppSocketFactory;
}

const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.();
});

function harness() {
  const { db, close } = createTestDb();
  openDbs.push(close);
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
  const sockets: FakeWhatsAppSocket[] = [];
  const socketFactory = fakeSocketFactory(sockets);
  registry.register(
    createWhatsAppDescriptor({
      syncSink: {
        upsertContacts: async () => {},
        upsertChats: async () => {},
        insertMessages: async () => {},
      } as never,
      onGuardianConnected: () => {},
      createAdapter: (authProvider) => new WhatsAppAdapter({ authProvider }, socketFactory),
    }),
  );
  const personMappingRepo = {
    findByChannelUser: async () => null,
    findByBondLevel: async () => [],
  } as unknown as PersonMappingRepository;
  const setupManager = new SetupManager({ registry, personMappingRepo });
  const deps = { connectionRegistry: registry, setupManager } as unknown as ApiDeps;
  const app = new Hono().route("/", setupsRoutes(deps));
  return { app, sockets };
}

async function setupState(app: Hono, cid: string): Promise<SetupState> {
  const response = await app.request(`/setups/${cid}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { state: SetupState }).state;
}

describe("WhatsApp generic setup — pairing readiness", () => {
  it("does not surface a code that WhatsApp immediately rejects before registration is ready", async () => {
    const { app, sockets } = harness();
    const started = await app.request("/connections/whatsapp/grants/session/setup", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(started.status).toBe(200);
    const { cid } = (await started.json()) as { cid: string };

    const input = await app.request(`/setups/${cid}/input`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ answers: { phoneNumber: "14155550134" } }),
    });
    expect(input.status).toBe(200);

    await rs.waitFor(() => expect(sockets).toHaveLength(1));
    // Leave a scheduling window in which the old implementation called
    // requestPairingCode too early and the fake WhatsApp server returned 401.
    await new Promise((resolve) => setTimeout(resolve, 25));

    sockets[0].ready = true;
    sockets[0].emit("connection.update", { qr: "registration-ready" });

    await rs.waitFor(
      async () => {
        const state = await setupState(app, cid);
        expect(state.status).toBe("presenting");
        if (state.status === "presenting") {
          expect(state.view.body).toContain("ABCD-1234");
        }
      },
      { timeout: 2_000 },
    );

    // Let any modeled immediate rejection land, then verify the setup remains
    // on the usable code rather than flipping to the reported failed state.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const final = await setupState(app, cid);
    expect(final.status).toBe("presenting");

    const cancelled = await app.request(`/setups/${cid}/cancel`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(cancelled.status).toBe(200);
  });
});
