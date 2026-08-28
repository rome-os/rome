import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";
import * as sharedModule from "../shared.js" with { rstest: "importActual" };

// Composio is the external system here; fake the connector client so the
// tool-result mapping can be exercised as a black box (given a provider
// response, assert the action result), without a live Composio account.
const loadConnectorClient = rs.fn();
// Keep the real shared helpers (ROME_USER_ID, isRomeManagedToolkit,
// romeManagedConnectHint, …) and fake only the Composio client — so the action's
// real Rome-managed routing is exercised and adding a shared export can't silently
// leave it undefined here.
rs.mock("../shared.js", () => ({
  ...sharedModule,
  loadConnectorClient: () => loadConnectorClient(),
}));

const { createAction } = await import("./connector-tool-execute/index.js");

const config: ActionConfig = {
  name: "connector_tool_execute",
  type: "custom",
  description: "connector_tool_execute",
  complexity: "simple",
  speed: "moderate",
  reliability: "medium",
  sideEffects: "write",
};
const deps = {} as unknown as AppActionRuntimeDeps;

// A connected, unambiguous managed account — the happy resolution so each test
// reaches the executeTool mapping under test.
function clientWithExecute(executeTool: () => Promise<unknown>) {
  return {
    findActiveConnectedAccount: async () => ({ kind: "ok", id: "acc_1" }),
    executeTool: () => executeTool(),
  };
}

const run = (input: Record<string, unknown>) => createAction(config, deps).execute(input);

describe("connector_tool_execute result mapping", () => {
  it("fails closed when the provider rejects the operation (ok:false -> action error)", async () => {
    loadConnectorClient.mockResolvedValueOnce(
      clientWithExecute(async () => ({
        ok: false,
        data: {},
        error: "Recipient address is invalid",
      })),
    );
    const result = await run({ toolkit: "gmail", slug: "GMAIL_SEND_EMAIL", args: { to: "bad" } });
    // The whole point of the fix: a refused upstream call must NOT read as ok.
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Recipient address is invalid/);
  });

  it("returns the tool's raw payload as data on success (no nested envelope)", async () => {
    loadConnectorClient.mockResolvedValueOnce(
      clientWithExecute(async () => ({
        ok: true,
        data: { id: "msg_1", threadId: "t_1" },
        error: null,
      })),
    );
    const result = await run({
      toolkit: "gmail",
      slug: "GMAIL_SEND_EMAIL",
      args: { to: "a@b.com" },
    });
    expect(result).toMatchObject({ status: "ok", data: { id: "msg_1", threadId: "t_1" } });
  });

  it("fails closed when the toolkit is not connected", async () => {
    loadConnectorClient.mockResolvedValueOnce({
      findActiveConnectedAccount: async () => ({ kind: "none" }),
      executeTool: async () => {
        throw new Error("executeTool must not be reached when no account is connected");
      },
    });
    const result = await run({ toolkit: "gmail", slug: "GMAIL_SEND_EMAIL", args: {} });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_connect/),
    });
  });

  it("routes an unconnected Rome-managed toolkit to Settings, not connector_connect", async () => {
    loadConnectorClient.mockResolvedValueOnce({
      findActiveConnectedAccount: async () => ({ kind: "none" }),
      executeTool: async () => {
        throw new Error("executeTool must not be reached when no account is connected");
      },
    });
    const result = await run({
      toolkit: "github",
      slug: "GITHUB_GET_THE_AUTHENTICATED_USER",
      args: {},
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/settings/i);
    expect(result.error).not.toMatch(/connector_connect/);
  });

  it("redirects a Rome-managed toolkit without a shell (Slack) to connector_proxy, before Composio", async () => {
    // No per-test mock reset in this file, so clear the shared spy's accumulated
    // call count before asserting Composio is never reached for Slack.
    loadConnectorClient.mockClear();
    loadConnectorClient.mockImplementation(() => {
      throw new Error("Composio must not be reached for a Rome-managed toolkit");
    });
    const result = await run({
      toolkit: "slack",
      slug: "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
      args: {},
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/connector_proxy/);
    expect(loadConnectorClient).not.toHaveBeenCalled();
  });
});
