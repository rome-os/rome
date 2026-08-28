import type { RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as composioClientModule from "./composio-client.js" with { rstest: "importActual" };
import * as composioLoginModule from "./composio-login.js" with { rstest: "importActual" };
import * as composioWebhookModule from "./composio-webhook.js" with { rstest: "importActual" };

const mocks = rs.hoisted(() => ({
  ensureWebhookRegistered: rs.fn(),
  readSessionApiKey: rs.fn(),
  client: {
    ensureAuthConfig: rs.fn(),
    ensureConnection: rs.fn(),
  },
}));

rs.mock("./composio-login.js", () => ({
  ...composioLoginModule,
  readSessionApiKey: mocks.readSessionApiKey,
}));

rs.mock("./composio-webhook.js", () => ({
  ...composioWebhookModule,
  ensureComposioWebhookRegistered: mocks.ensureWebhookRegistered,
}));

rs.mock("./composio-client.js", () => {
  return {
    ...composioClientModule,
    ComposioClient: class {
      constructor() {
        return mocks.client;
      }
    },
  };
});

import { createApiHandler } from "./index.js";

describe("connector API webhook self-healing", () => {
  beforeEach(() => {
    rs.resetAllMocks();
    mocks.readSessionApiKey.mockResolvedValue("test-api-key");
    mocks.ensureWebhookRegistered.mockRejectedValue(new Error("relay unavailable"));
    mocks.client.ensureAuthConfig.mockResolvedValue("auth-config-1");
    mocks.client.ensureConnection.mockResolvedValue({
      kind: "redirect",
      url: "https://platform.composio.dev/connect",
    });
  });

  it("continues the OAuth connection when webhook self-healing fails", async () => {
    const warn = rs.fn();
    const ctx = {
      db: {},
      repositories: { settings: {} },
      log: { warn, error: rs.fn(), info: rs.fn() },
    } as unknown as RomeAppContext;
    const request = {
      method: "POST",
      path: ["connectors"],
      headers: { host: "rome.test" },
      body: new TextEncoder().encode(JSON.stringify({ provider: "notion" })),
    } as unknown as RomeAppApiRequest;

    const response = await createApiHandler(ctx).handle(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: "notion",
      authorizationUrl: "https://platform.composio.dev/connect",
    });
    expect(mocks.ensureWebhookRegistered).toHaveBeenCalledOnce();
    expect(mocks.client.ensureAuthConfig).toHaveBeenCalledWith("notion");
    expect(warn).toHaveBeenCalledWith(
      "connectors.start: webhook registration failed; continuing OAuth",
      expect.objectContaining({ provider: "notion", error: "relay unavailable" }),
    );
  });
});
