// Black-box regression for the generic WhatsApp setup surface.
//
// The test drives only HTTP and observes only setup states. Everything Rome
// owns is real: Hono routes, SetupManager/SetupSession, the WhatsApp setup
// coroutine, the QR renderer, and WhatsAppAdapter. The sole fake is the
// external WhatsApp socket boundary, which issues rotating linking QRs and then
// opens once "scanned".

import { Hono } from "hono";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { setupsRoutes } from "../../api/routes/setups.js";
import type { ApiDeps } from "../../api/deps.js";
import { WhatsAppAdapter, type WhatsAppSocketFactory } from "../../channels/whatsapp.js";
import type { PeopleRepository } from "../../db/repositories/people.js";
import { createTestDb } from "../../test/helpers.js";
import { DrizzleConnectionsRepository } from "../repository-db.js";
import { ConnectionRegistry } from "../registry.js";
import { SetupManager } from "../setup/manager.js";
import type { SetupState } from "../setup/types.js";
import { createWhatsAppDescriptor } from "./whatsapp.js";

const SAME_ORIGIN = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

interface FakeWhatsAppSocket {
  user?: { id: string };
  emit(event: string, payload: unknown): void;
}

function fakeSocketFactory(controls: FakeWhatsAppSocket[]): WhatsAppSocketFactory {
  return (() => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const socket = {
      ev: {
        on(event: string, handler: (payload: unknown) => void) {
          const listeners = handlers.get(event) ?? [];
          listeners.push(handler);
          handlers.set(event, listeners);
        },
      },
      end: rs.fn(),
      sendMessage: rs.fn(),
      user: undefined as { id: string } | undefined,
      emit(event: string, payload: unknown) {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
    };
    controls.push(socket);
    return socket;
  }) as unknown as WhatsAppSocketFactory;
}

const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.();
});

function harness() {
  const { db, close } = createTestDb();
  openDbs.push(close);
  const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
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
  const peopleRepo = {
    byAccount: async () => null,
    isDismissed: async () => false,
    byBondLevel: async () => [],
  } as unknown as PeopleRepository;
  const setupManager = new SetupManager({ registry, peopleRepo });
  const deps = { connectionRegistry: registry, setupManager } as unknown as ApiDeps;
  const app = new Hono().route("/", setupsRoutes(deps));
  return { app, sockets };
}

async function setupState(app: Hono, cid: string): Promise<SetupState> {
  const response = await app.request(`/setups/${cid}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { state: SetupState }).state;
}

async function presentedQr(app: Hono, cid: string): Promise<string | undefined> {
  const state = await setupState(app, cid);
  expect(state.status).toBe("presenting");
  return state.status === "presenting" ? state.view.qr : undefined;
}

describe("WhatsApp generic setup — QR linking", () => {
  it("presents each rotating QR as an image and grants once the phone links", async () => {
    const { app, sockets } = harness();
    const started = await app.request("/connections/whatsapp/grants/session/setup", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(started.status).toBe(200);
    const { cid } = (await started.json()) as { cid: string };

    // No form to fill: the transient socket starts immediately.
    await rs.waitFor(() => expect(sockets).toHaveLength(1));
    expect(await presentedQr(app, cid)).toBeUndefined();

    sockets[0].emit("connection.update", { qr: "2@first-ref,key,adv" });
    let first: string | undefined;
    await rs.waitFor(async () => {
      first = await presentedQr(app, cid);
      expect(first).toMatch(/^data:image\/png;base64,/);
    });

    sockets[0].emit("connection.update", { qr: "2@second-ref,key,adv" });
    await rs.waitFor(async () => {
      const second = await presentedQr(app, cid);
      expect(second).toMatch(/^data:image\/png;base64,/);
      expect(second).not.toBe(first);
    });

    // The phone scans: WhatsApp opens the session as the linked account.
    sockets[0].user = { id: "14155550134:7@s.whatsapp.net" };
    sockets[0].emit("connection.update", { connection: "open" });
    await rs.waitFor(async () => {
      const state = await setupState(app, cid);
      expect(state.status).toBe("done");
      if (state.status === "done") {
        expect(state.grant.summary?.body?.[0]).toContain("+14155550134");
      }
    });
  });
});
