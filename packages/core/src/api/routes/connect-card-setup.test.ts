// The connect card's Connect and the Connections page's Connect start one
// setup: the card's goes through `startConnectionSetup`, the page's through
// `POST /connections/:id/grants/:name/setup`, over one registry and one setup
// manager, so the second finds the setup the first started.

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

rs.mock("../../connections/integrations/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider: rs.fn(async () => {}),
  clearGithubShellIntegrationForProvider: rs.fn(async () => {}),
}));
rs.mock("../../connections/oauth/provider-token-files.js", () => ({
  syncProviderTokenFile: rs.fn(async () => {}),
  clearProviderTokenFile: rs.fn(async () => {}),
}));

import { makeOAuthProviderDescriptor } from "../../connections/integrations/oauth-providers.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { DrizzleConnectionsRepository } from "../../connections/repository-db.js";
import { SetupManager } from "../../connections/setup/manager.js";
import { startConnectionSetup } from "../../connections/setup/start.js";
import { connectCardUiFromProps } from "../../connections/connect-card.js";
import { createTestDb } from "../../test/db.js";
import type { ApiDeps } from "../deps.js";
import { connectionsRoutes } from "./connections.js";
import { setupsRoutes } from "./setups.js";
import { widgetEventRoutes } from "./widget-events.js";

const AUTHORIZE_URL = "https://broker.example/authorize?state=st-card-1";
const SAME_ORIGIN = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

let close: () => void = () => {};
beforeEach(() => {
  rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
});
afterEach(() => {
  rs.unstubAllEnvs();
  close();
});

function harness() {
  const testDb = createTestDb();
  close = testDb.close;
  const registry = new ConnectionRegistry({
    repository: new DrizzleConnectionsRepository(testDb.db),
  });
  registry.register(
    makeOAuthProviderDescriptor("github", {
      beginRedirect: async () => AUTHORIZE_URL,
      redeem: async () => ({
        credential: { material: { accessToken: "tok" }, expiresAt: "never" },
        profile: { login: "octocat" },
      }),
    }),
  );
  const manager = new SetupManager({
    registry,
    participant: { onConnect: async () => {} } as never,
  });
  const deps = {
    db: testDb.db,
    connectionRegistry: registry,
    setupManager: manager,
  } as unknown as ApiDeps;
  const api = new Hono().route("/", setupsRoutes(deps)).route("/", connectionsRoutes(deps));
  const card = {
    type: "pending_interaction",
    toolUseId: "k1",
    appId: "core",
    render: {
      kind: "inline",
      componentId: "connect-card",
      props: { kind: "github" },
      ui: connectCardUiFromProps({ kind: "github" }),
    },
  };
  const widgets = widgetEventRoutes({
    webchatRepo: {
      askingDeviceOf: async () => null,
      widgetMessage: async () => ({ chatId: "private", content: JSON.stringify([card]) }),
      getMessages: (async () => [
        { id: "m", role: "assistant", content: JSON.stringify([card]) },
      ]) as never,
      getSession: (async (id: string) => ({
        id,
        agentName: "main",
        ownerKey: "guardian",
        triggerKind: null,
      })) as never,
    },
    callerOwner: async () => "guardian",
    // The card reads the connections as `GET /api/connections` lists them.
    forward: (request) => {
      const url = new URL(request.url);
      return api.request(url.pathname.replace(/^\/api/, "") + url.search, request);
    },
    startSetup: (request) => startConnectionSetup({ registry, manager }, request),
  });
  return { api, widgets };
}

describe("the connect card's Connect", () => {
  it("starts the setup the Connections page's Connect starts", async () => {
    const { api, widgets } = harness();

    const pressed = await widgets.request("/chat/widgets/m/events", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ name: "connect", context: { kind: "github" } }),
    });
    expect(await pressed.json()).toEqual({ open: AUTHORIZE_URL });

    // The page's Connect, as the dashboard sends it, finds that setup.
    const page = await api.request("/connections/github/grants/user/setup", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ force: false }),
    });
    expect(await page.json()).toMatchObject({
      reattached: true,
      state: { status: "awaiting-redirect", url: AUTHORIZE_URL },
    });
  });
});
