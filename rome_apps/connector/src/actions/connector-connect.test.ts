import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as composioWebhookModule from "../api/composio-webhook.js" with { rstest: "importActual" };
import * as sharedModule from "../shared.js" with { rstest: "importActual" };

const mocks = rs.hoisted(() => ({
  ensureWebhookRegistered: rs.fn(),
  loadConnectorClient: rs.fn(),
}));

rs.mock("../shared.js", () => ({
  ...sharedModule,
  loadConnectorClient: mocks.loadConnectorClient,
}));

rs.mock("../api/composio-webhook.js", () => ({
  ...composioWebhookModule,
  ensureComposioWebhookRegistered: mocks.ensureWebhookRegistered,
}));

import { createAction } from "./connector-connect/index.js";

const config: ActionConfig = {
  name: "connector_connect",
  type: "custom",
  description: "Connect a toolkit",
  complexity: "simple",
  speed: "fast",
  reliability: "medium",
  sideEffects: "read-only",
};

describe("connector_connect webhook self-healing", () => {
  beforeEach(() => {
    rs.resetAllMocks();
    mocks.loadConnectorClient.mockResolvedValue({
      findActiveConnectedAccount: rs.fn().mockResolvedValue({ kind: "ok", id: "ca_1" }),
    });
    mocks.ensureWebhookRegistered.mockRejectedValue(new Error("relay unavailable"));
  });

  it("keeps an existing connection usable when webhook self-healing fails", async () => {
    const deps = {
      appContext: { db: {}, repositories: { settings: {} } },
    } as unknown as AppActionRuntimeDeps;

    const result = await createAction(config, deps).execute({ toolkit: "notion" });

    expect(result).toEqual({ status: "ok", data: { toolkit: "notion", status: "connected" } });
    expect(mocks.ensureWebhookRegistered).toHaveBeenCalledOnce();
  });
});
