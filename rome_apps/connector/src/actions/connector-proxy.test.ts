import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as sharedModule from "../shared.js" with { rstest: "importActual" };

// Composio is the external system here; fake the connector client so the
// response-mapping can be exercised as a black box (given an upstream response,
// assert the action result), without a live Composio account.
const loadConnectorClient = rs.fn();
// Keep the real shared helpers (ROME_USER_ID, isRomeManagedToolkit,
// romeManagedConnectHint, …) and fake only the Composio client — so the action's
// real Rome-managed routing is exercised and adding a shared export can't silently
// leave it undefined here.
rs.mock("../shared.js", () => ({
  ...sharedModule,
  loadConnectorClient: () => loadConnectorClient(),
}));

// GitHub is brokered by Rome's own integration, not Composio — fake the direct
// GitHub proxy (token read + HTTP call) so its branch is exercised as a black box
// without a token file on disk or a live GitHub API.
const readGithubOAuthToken = rs.fn();
const githubProxyCall = rs.fn();
rs.mock("../api/github-proxy.js", () => ({
  readGithubOAuthToken: () => readGithubOAuthToken(),
  githubProxyCall: (args: unknown) => githubProxyCall(args),
}));

// Slack is likewise brokered by Rome's own integration, not Composio — fake the
// direct Slack proxy (token read + HTTP call) so its branch is exercised as a
// black box without a token file on disk or a live Slack API.
const readSlackOAuthTokens = rs.fn();
const slackProxyCall = rs.fn();
rs.mock("../api/slack-proxy.js", () => ({
  readSlackOAuthTokens: () => readSlackOAuthTokens(),
  slackProxyCall: (args: unknown) => slackProxyCall(args),
}));

const { createAction } = await import("./connector-proxy/index.js");

const config: ActionConfig = {
  name: "connector_proxy",
  type: "custom",
  description: "connector_proxy",
  complexity: "simple",
  speed: "moderate",
  reliability: "medium",
  sideEffects: "write",
};
const deps = {} as unknown as AppActionRuntimeDeps;

// A connected, unambiguous managed account — the happy resolution so each test
// reaches the proxy response mapping under test.
function clientWithProxy(proxyTool: () => Promise<unknown>) {
  return {
    findActiveConnectedAccount: async () => ({ kind: "ok", id: "acc_1" }),
    proxyTool: () => proxyTool(),
  };
}

const run = (input: Record<string, unknown>) => createAction(config, deps).execute(input);

beforeEach(() => {
  rs.clearAllMocks();
});

// path-only call: linear's default host (api.linear.app) is filled in by Rome, so
// the assembled endpoint is https://api.linear.app/graphql.
const linearCall = {
  toolkit: "linear",
  path: "/graphql",
  method: "POST",
  body: { query: "{ viewer { id } }" },
};

describe("connector_proxy response mapping", () => {
  it("returns the provider's status, body, and headers as data on a 2xx", async () => {
    loadConnectorClient.mockResolvedValueOnce(
      clientWithProxy(async () => ({
        status: 200,
        data: { data: { viewer: { id: "u_1" } } },
        headers: { "content-type": "application/json" },
      })),
    );
    const result = await run(linearCall);
    expect(result).toMatchObject({
      status: "ok",
      data: {
        status: 200,
        data: { data: { viewer: { id: "u_1" } } },
        headers: { "content-type": "application/json" },
      },
    });
  });

  it("forwards query + headers to the proxy (the injection-safe path for dynamic values)", async () => {
    let received: unknown;
    loadConnectorClient.mockResolvedValueOnce({
      findActiveConnectedAccount: async () => ({ kind: "ok", id: "acc_1" }),
      proxyTool: async (args: unknown) => {
        received = args;
        return { status: 200, data: {}, headers: {} };
      },
    });
    await run({
      toolkit: "linear",
      path: "/graphql",
      method: "GET",
      query: { profile: "a&b=c" },
      headers: { "X-Trace": "1" },
    });
    expect(received).toMatchObject({
      endpoint: "https://api.linear.app/graphql",
      query: { profile: "a&b=c" },
      headers: { "X-Trace": "1" },
    });
  });

  it("fills in the toolkit's default host when host is omitted (path-only call)", async () => {
    let received: { endpoint?: string } | undefined;
    loadConnectorClient.mockResolvedValueOnce({
      findActiveConnectedAccount: async () => ({ kind: "ok", id: "acc_1" }),
      proxyTool: async (args: { endpoint?: string }) => {
        received = args;
        return { status: 200, data: {}, headers: {} };
      },
    });
    // Notion is Composio-managed (not Rome-managed), so the call goes through the
    // Composio proxy with Rome filling in api.notion.com.
    await run({ toolkit: "notion", path: "/v1/users/me", method: "GET" });
    expect(received?.endpoint).toBe("https://api.notion.com/v1/users/me");
  });

  it("uses an explicit host override to reach a provider's non-default host", async () => {
    let received: { endpoint?: string } | undefined;
    loadConnectorClient.mockResolvedValueOnce({
      findActiveConnectedAccount: async () => ({ kind: "ok", id: "acc_1" }),
      proxyTool: async (args: { endpoint?: string }) => {
        received = args;
        return { status: 200, data: {}, headers: {} };
      },
    });
    // Dropbox content lives on content.dropboxapi.com, not the default
    // api.dropboxapi.com — still within the dropboxapi.com allowlist, so it's allowed.
    await run({
      toolkit: "dropbox",
      host: "content.dropboxapi.com",
      path: "/2/files/download",
      method: "POST",
      body: {},
    });
    expect(received?.endpoint).toBe("https://content.dropboxapi.com/2/files/download");
  });

  it("requires an explicit host for a per-connection toolkit (Supabase)", async () => {
    // Supabase has no default host (per-project `<ref>.supabase.co`), so a
    // path-only call is refused before any network/credential use.
    const result = await run({ toolkit: "supabase", path: "/rest/v1/orders", method: "GET" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Refusing to proxy/);
    expect(result.error).toMatch(/host/);
  });

  it("fails closed when the provider rejects the request (non-2xx -> action error)", async () => {
    loadConnectorClient.mockResolvedValueOnce(
      clientWithProxy(async () => ({
        status: 401,
        data: { error: "invalid token" },
        headers: {},
      })),
    );
    const result = await run(linearCall);
    // The point of fail-closed: a 401 must NOT read as ok with a nested error body.
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/401/);
    expect(result.error).toMatch(/invalid token/);
  });

  it("fails closed when the toolkit is not connected", async () => {
    loadConnectorClient.mockResolvedValueOnce({
      findActiveConnectedAccount: async () => ({ kind: "none" }),
      proxyTool: async () => {
        throw new Error("proxyTool must not be reached when no account is connected");
      },
    });
    const result = await run(linearCall);
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_connect/),
    });
  });

  // The endpoint carries the connection's live OAuth credential to whatever host
  // it names, so an off-provider host is credential theft, not just SSRF. A
  // caller-supplied `host` is the only way to name a host now, so these drive the
  // bad host through `host`. Each rejection happens BEFORE the client loads (no
  // `mockResolvedValueOnce`), so a "Refusing to proxy" error — rather than the
  // not-signed-in error — proves the host never reached the credential.
  it("refuses a full URL supplied as the path", async () => {
    const result = await run({ ...linearCall, path: "https://evil.example.com/graphql" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Refusing to proxy/);
    expect(result.error).toMatch(/full URL/);
  });

  it("refuses an off-provider host for the toolkit (credential exfiltration)", async () => {
    const result = await run({ ...linearCall, host: "evil.example.com" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Refusing to proxy/);
    expect(result.error).toMatch(/evil\.example\.com/);
  });

  it("refuses a userinfo-trick host that resolves off-provider", async () => {
    const result = await run({ ...linearCall, host: "api.linear.app@evil.example.com" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Refusing to proxy/);
  });

  it("refuses a subdomain-suffix spoof of the provider domain", async () => {
    const result = await run({ ...linearCall, host: "api.linear.app.evil.com" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Refusing to proxy/);
  });

  it("allows a legitimate provider subdomain (gmail → *.googleapis.com)", async () => {
    loadConnectorClient.mockResolvedValueOnce(
      clientWithProxy(async () => ({
        status: 200,
        data: { emailAddress: "a@b.com" },
        headers: {},
      })),
    );
    const result = await run({
      toolkit: "gmail",
      path: "/gmail/v1/users/me/profile",
      method: "GET",
    });
    expect(result).toMatchObject({ status: "ok", data: { data: { emailAddress: "a@b.com" } } });
  });

  it("routes an unconnected GitHub (no token) to Settings, not connector_connect", async () => {
    // GitHub bypasses Composio entirely — "not connected" means no OAuth token
    // file, so the agent is pointed at Settings → Connections, never asked to
    // run connector_connect (which can't broker a Rome-managed toolkit).
    readGithubOAuthToken.mockResolvedValueOnce(null);
    loadConnectorClient.mockImplementation(() => {
      throw new Error("Composio must not be reached for GitHub");
    });
    const result = await run({ toolkit: "github", path: "/user", method: "GET" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/settings/i);
    expect(result.error).not.toMatch(/connector_connect/);
    expect(githubProxyCall).not.toHaveBeenCalled();
  });

  it("proxies GitHub directly with the OAuth token, bypassing Composio", async () => {
    readGithubOAuthToken.mockResolvedValueOnce("gho_token");
    loadConnectorClient.mockImplementation(() => {
      throw new Error("Composio must not be reached for GitHub");
    });
    let received: unknown;
    githubProxyCall.mockImplementation(async (args: unknown) => {
      received = args;
      return {
        status: 200,
        data: { login: "octocat" },
        headers: { "x-ratelimit-remaining": "59" },
      };
    });
    const result = await run({ toolkit: "github", path: "/user", method: "GET" });
    expect(received).toMatchObject({
      token: "gho_token",
      endpoint: "https://api.github.com/user",
      method: "GET",
    });
    expect(result).toMatchObject({
      status: "ok",
      data: { status: 200, data: { login: "octocat" } },
    });
  });

  it("fails closed when GitHub rejects the request (non-2xx -> action error)", async () => {
    readGithubOAuthToken.mockResolvedValueOnce("gho_token");
    githubProxyCall.mockResolvedValueOnce({
      status: 404,
      data: { message: "Not Found" },
      headers: {},
    });
    const result = await run({ toolkit: "github", path: "/repos/o/missing", method: "GET" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/404/);
    expect(result.error).toMatch(/Not Found/);
  });

  it("refuses an off-provider host for GitHub before reading the token", async () => {
    // The host gate runs ahead of the token read, so a credential-exfil host can
    // never reach the OAuth token regardless of connection state.
    const result = await run({
      toolkit: "github",
      host: "evil.example.com",
      path: "/user",
      method: "GET",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Refusing to proxy/);
    expect(readGithubOAuthToken).not.toHaveBeenCalled();
  });

  it("routes an unconnected Slack (no token) to Settings, not connector_connect", async () => {
    // Slack bypasses Composio entirely — "not connected" means no OAuth token
    // file, so the agent is pointed at Settings → Connections, never asked to
    // run connector_connect (which can't broker a Rome-managed toolkit).
    readSlackOAuthTokens.mockResolvedValueOnce(null);
    loadConnectorClient.mockImplementation(() => {
      throw new Error("Composio must not be reached for Slack");
    });
    const result = await run({ toolkit: "slack", path: "/api/auth.test", method: "POST" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/settings/i);
    expect(result.error).not.toMatch(/connector_connect/);
    expect(slackProxyCall).not.toHaveBeenCalled();
  });

  it("proxies Slack directly with the OAuth token, bypassing Composio", async () => {
    readSlackOAuthTokens.mockResolvedValueOnce({
      botToken: "xoxb-bot",
      userToken: "xoxp-user",
      teamId: "T1",
    });
    loadConnectorClient.mockImplementation(() => {
      throw new Error("Composio must not be reached for Slack");
    });
    let received: unknown;
    slackProxyCall.mockImplementation(async (args: unknown) => {
      received = args;
      return { status: 200, data: { ok: true, channel: "C1" }, headers: {} };
    });
    const result = await run({
      toolkit: "slack",
      path: "/api/chat.postMessage",
      method: "POST",
      body: { channel: "C1", text: "hi" },
    });
    expect(received).toMatchObject({
      tokens: { botToken: "xoxb-bot" },
      endpoint: "https://slack.com/api/chat.postMessage",
      method: "POST",
    });
    expect(result).toMatchObject({ status: "ok", data: { status: 200, data: { ok: true } } });
  });

  it("fails closed when Slack returns ok:false inside a 200 (logical failure)", async () => {
    readSlackOAuthTokens.mockResolvedValueOnce({
      botToken: "xoxb-bot",
      userToken: null,
      teamId: "T1",
    });
    slackProxyCall.mockResolvedValueOnce({
      status: 200,
      data: { ok: false, error: "channel_not_found" },
      headers: {},
    });
    const result = await run({ toolkit: "slack", path: "/api/chat.postMessage", method: "POST" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/ok:false/);
    expect(result.error).toMatch(/channel_not_found/);
  });

  it("fails closed when Slack rejects the request (non-2xx -> action error)", async () => {
    readSlackOAuthTokens.mockResolvedValueOnce({
      botToken: "xoxb-bot",
      userToken: null,
      teamId: "T1",
    });
    slackProxyCall.mockResolvedValueOnce({
      status: 429,
      data: { error: "rate_limited" },
      headers: {},
    });
    const result = await run({ toolkit: "slack", path: "/api/chat.postMessage", method: "POST" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/429/);
  });

  it("refuses an off-provider host for Slack before reading the token", async () => {
    const result = await run({
      toolkit: "slack",
      host: "evil.example.com",
      path: "/api/auth.test",
      method: "POST",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Refusing to proxy/);
    expect(readSlackOAuthTokens).not.toHaveBeenCalled();
  });
});
