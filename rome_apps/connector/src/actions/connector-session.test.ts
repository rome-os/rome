import { APIError } from "@composio/client";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as composioWebhookModule from "../api/composio-webhook.js" with { rstest: "importActual" };
import * as sharedModule from "../shared.js" with { rstest: "importActual" };

// A saved Composio key can be revoked upstream. These tests pin that
// connector_login and the Composio-backed actions agree on when that happened,
// so an agent sent to connector_login is never told it is already signed in.
// Separate from connector-actions.test.ts, whose HOME redirect needs the real
// loadConnectorClient that this file mocks.

const mocks = rs.hoisted(() => ({
  loadConnectorClient: rs.fn(),
  ensureWebhookRegistered: rs.fn(),
}));

rs.mock("../shared.js", () => ({
  ...sharedModule,
  loadConnectorClient: mocks.loadConnectorClient,
}));

rs.mock("../api/composio-webhook.js", () => ({
  ...composioWebhookModule,
  ensureComposioWebhookRegistered: mocks.ensureWebhookRegistered,
}));

const { createAction: createConnectorConnect } = await import("./connector-connect/index.js");
const { createAction: createConnectorEventSchema } = await import(
  "./connector-event-schema/index.js"
);
const { createAction: createConnectorEventSearch } = await import(
  "./connector-event-search/index.js"
);
const { createAction: createConnectorEventSubscribe } = await import(
  "./connector-event-subscribe/index.js"
);
const { createAction: createConnectorLogin } = await import("./connector-login/index.js");
const { createAction: createConnectorSearch } = await import("./connector-search/index.js");
const { createAction: createConnectorToolExecute } = await import(
  "./connector-tool-execute/index.js"
);
const { createAction: createConnectorToolSchema } = await import(
  "./connector-tool-schema/index.js"
);

const config = (name: string): ActionConfig => ({
  name,
  type: "custom",
  description: name,
  complexity: "simple",
  speed: "fast",
  reliability: "medium",
  sideEffects: "read-only",
});

const deps = {
  appContext: { db: {}, repositories: { settings: {} } },
} as unknown as AppActionRuntimeDeps;

type Ping = { ok: true } | { ok: false; status: number; message: string };

// The error the SDK throws when Composio rejects Rome's own CLI session key.
const revokedKey = () =>
  APIError.generate(
    401,
    { error: { slug: "UserApiKey_Unauthorized", message: "Invalid or revoked user API key" } },
    undefined,
    new Headers(),
  );

// Every Composio call the actions make rejects with the revoked-key error, so
// each action reaches its catch on its first upstream call.
function revokedClient(ping: Ping) {
  const reject = async () => {
    throw revokedKey();
  };
  return {
    ping: async () => ping,
    findActiveConnectedAccount: reject,
    executeTool: reject,
    searchTools: reject,
    getToolSchema: reject,
    listTriggerTypes: reject,
    getTriggerSchema: reject,
    getTriggerType: reject,
    createTrigger: reject,
  };
}

beforeEach(() => {
  rs.resetAllMocks();
  mocks.ensureWebhookRegistered.mockResolvedValue(undefined);
});

describe("connector_login with a saved key", () => {
  const login = () => createConnectorLogin(config("connector_login"), deps).execute({});

  it("reports signed_in when the saved key pings OK", async () => {
    mocks.loadConnectorClient.mockResolvedValue({ ping: async () => ({ ok: true }) });
    expect(await login()).toEqual({ status: "ok", data: { status: "signed_in" } });
  });

  it("shows the sign-in card again when Composio rejects the saved key", async () => {
    mocks.loadConnectorClient.mockResolvedValue({
      ping: async () => ({ ok: false, status: 401, message: "revoked" }),
    });
    const result = await login();
    expect(result).toMatchObject({
      status: "pending_interaction",
      interaction: {
        appId: "connector",
        promptText: expect.stringMatching(/sign in again/i),
        render: { kind: "inline", componentId: "login-card", props: {} },
      },
    });
  });

  it.each([
    [0, "fetch failed"],
    [503, "Service Unavailable"],
  ])("reports an error, not a verdict, when the ping fails with %i", async (status, message) => {
    mocks.loadConnectorClient.mockResolvedValue({
      ping: async () => ({ ok: false, status, message }),
    });
    const result = await login();
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain(message);
  });
});

const actions: [string, Action, Record<string, unknown>][] = [
  [
    "connector_connect",
    createConnectorConnect(config("connector_connect"), deps),
    { toolkit: "notion" },
  ],
  [
    "connector_event_schema",
    createConnectorEventSchema(config("connector_event_schema"), deps),
    { toolkit: "gmail", slug: "GMAIL_NEW_GMAIL_MESSAGE" },
  ],
  [
    "connector_event_search",
    createConnectorEventSearch(config("connector_event_search"), deps),
    { toolkit: "gmail" },
  ],
  [
    "connector_event_subscribe",
    createConnectorEventSubscribe(config("connector_event_subscribe"), deps),
    { toolkit: "gmail", slug: "GMAIL_NEW_GMAIL_MESSAGE", config: {} },
  ],
  [
    "connector_search",
    createConnectorSearch(config("connector_search"), deps),
    { query: "send an email" },
  ],
  [
    "connector_tool_execute",
    createConnectorToolExecute(config("connector_tool_execute"), deps),
    { toolkit: "gmail", slug: "GMAIL_SEND_EMAIL", args: {} },
  ],
  [
    "connector_tool_schema",
    createConnectorToolSchema(config("connector_tool_schema"), deps),
    { toolkit: "gmail", slug: "GMAIL_SEND_EMAIL" },
  ],
];

describe("Composio-backed actions when Composio rejects the saved key", () => {
  it.each(actions)("%s sends the agent to connector_login", async (name, action, input) => {
    mocks.loadConnectorClient.mockResolvedValue(
      revokedClient({ ok: false, status: 401, message: "revoked" }),
    );
    const result = await action.execute(input);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/connector_login/);
    expect(result.error).toContain(`re-run ${name}`);
    expect(result.error).toMatch(/UserApiKey_Unauthorized/);
  });

  it.each(
    actions,
  )("%s keeps its generic error when the key still pings OK", async (_n, action, input) => {
    mocks.loadConnectorClient.mockResolvedValue(revokedClient({ ok: true }));
    const result = await action.execute(input);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).not.toMatch(/connector_login/);
    expect(result.error).toMatch(/UserApiKey_Unauthorized/);
  });
});
