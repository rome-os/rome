import { afterEach, describe, expect, it } from "@rstest/core";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AuditStore,
  createFileCredentialStore,
  type HostCredential,
} from "@rome-os/node-core/host";
import { createWebAuth, isLoopbackHost } from "./auth.js";
import { HostController } from "./host-controller.js";
import { startWebServer } from "./server.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await delay(25);
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function createAssetsFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rome-node-web-assets-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "static"), { recursive: true });
  const html = "<!doctype html><html><body>Rome Node Web</body></html>";
  const js = "console.log('rome-node-web');";
  await writeFile(join(dir, "index.html"), html, "utf8");
  await writeFile(join(dir, "static", "app.js"), js, "utf8");
  await writeFile(join(dir, "static", "app.js.gz"), gzipSync(Buffer.from(js, "utf8")));
  return dir;
}

async function createMockCloudAndGateway() {
  const token = `romedev_${"b".repeat(43)}`;
  const deviceId = "dev-container-1";
  let approveDeviceCode = false;
  let gatewaySocket: WebSocket | undefined;
  let gatewayConnections = 0;

  const gateway = createServer();
  const wss = new WebSocketServer({ server: gateway });
  const gatewayUrl = (await listen(gateway)).replace("http:", "ws:");
  cleanup.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  wss.on("connection", (socket) => {
    gatewayConnections += 1;
    gatewaySocket = socket;
  });

  let cloudUrl = "";
  const cloud = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain request body.
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/oauth2/device_authorization") {
      res.end(
        JSON.stringify({
          device_code: "secret-device-code-never-expose",
          user_code: "ROME-2026",
          verification_uri: `${cloudUrl}/device`,
          verification_uri_complete: `${cloudUrl}/device?user_code=ROME-2026`,
          expires_in: 300,
          interval: 1,
        }),
      );
      return;
    }
    if (req.url === "/oauth2/token") {
      if (!approveDeviceCode) {
        res.writeHead(400).end(JSON.stringify({ error: "authorization_pending" }));
      } else {
        res.end(JSON.stringify({ access_token: token, token_type: "Bearer", device_id: deviceId }));
      }
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: "invalid_device_session" }));
      return;
    }
    if (req.url === "/v1/gateway/config") {
      res.end(JSON.stringify({ gatewayUrl }));
      return;
    }
    if (req.url === "/api/account/devices") {
      res.end(JSON.stringify({ items: [{ id: deviceId, device_name: "Test Container" }] }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  cloudUrl = await listen(cloud);

  async function sendRpc(action: string, args: Record<string, unknown> = {}) {
    if (!gatewaySocket) throw new Error("Gateway not connected");
    const socket = gatewaySocket;
    const id = `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("RPC timeout")), 4000);
      const onMessage = (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString("utf8")) as {
          id?: string;
          payload?: Record<string, unknown>;
        };
        if (parsed.id === id) {
          clearTimeout(timer);
          socket.off("message", onMessage);
          resolve(parsed.payload ?? {});
        }
      };
      socket.on("message", onMessage);
    });
    socket.send(
      JSON.stringify({
        id,
        from: "caller-instance",
        payload: { type: "request", action, args },
      }),
    );
    return reply;
  }

  return {
    cloudUrl,
    deviceId,
    token,
    approve() {
      approveDeviceCode = true;
    },
    getSocket: () => gatewaySocket,
    getConnections: () => gatewayConnections,
    sendRpc,
  };
}

describe("rome-node web server", () => {
  it("classifies loopback and non-loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });

  it("supports passwordless localhost default, custom scrypt password lifecycle, and env password auth", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "rome-node-web-auth-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    const assetsDir = await createAssetsFixture();
    const logs: string[] = [];

    // Default startup is passwordless on localhost even when listening on 0.0.0.0 (Docker pattern).
    const first = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: configDir,
      assetsDir,
      log: (line) => logs.push(line),
    });

    expect(first.authRequired).toBe(false);
    expect(first.passwordSource).toBe("none");
    expect(logs.some((line) => line.includes("passwordless for localhost"))).toBe(true);

    // Health check works without authentication.
    const health = await fetch(`${first.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    // Localhost API works immediately without password.
    const initialSession = (await (await fetch(`${first.url}/api/auth/session`)).json()) as {
      authRequired: boolean;
      authenticated: boolean;
      passwordSource: string;
      canRemovePassword: boolean;
    };
    expect(initialSession).toEqual({
      authRequired: false,
      authenticated: true,
      passwordSource: "none",
      canRemovePassword: true,
    });
    expect((await fetch(`${first.url}/api/status`)).status).toBe(200);

    // Setting too short password is rejected.
    const shortRes = await fetch(`${first.url}/api/auth/password`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newPassword: "123" }),
    });
    expect(shortRes.status).toBe(400);

    // Setting a custom password persists scrypt hash to web-auth.json and returns session cookie.
    const setRes = await fetch(`${first.url}/api/auth/password`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newPassword: "my-custom-pass" }),
    });
    expect(setRes.status).toBe(200);
    expect(first.authRequired).toBe(true);
    expect(first.passwordSource).toBe("file");
    const savedAuth = JSON.parse(await readFile(join(configDir, "web-auth.json"), "utf8")) as {
      version: number;
      salt: string;
      hash: string;
    };
    expect(savedAuth.version).toBe(1);
    expect(savedAuth.salt).toHaveLength(32);
    expect(savedAuth.hash).toHaveLength(128);
    expect(JSON.stringify(savedAuth)).not.toContain("my-custom-pass");
    const cookieAfterSet = (setRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(
      (await fetch(`${first.url}/api/status`, { headers: { cookie: cookieAfterSet } })).status,
    ).toBe(200);
    expect((await fetch(`${first.url}/api/status`)).status).toBe(401);

    await first.close();

    // Restarting with the same configDir loads the persisted custom password automatically.
    const running = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: configDir,
      assetsDir,
      log: () => {},
    });
    cleanup.push(() => running.close());

    expect(running.authRequired).toBe(true);
    expect(running.passwordSource).toBe("file");
    expect((await fetch(`${running.url}/api/status`)).status).toBe(401);

    // Cross-origin login is rejected.
    const csrf = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ password: "my-custom-pass" }),
    });
    expect(csrf.status).toBe(403);

    // Wrong password fails with 401.
    const badLogin = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(badLogin.status).toBe(401);

    // Correct password issues HttpOnly SameSite=Strict cookie.
    const login = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "my-custom-pass" }),
    });
    expect(login.status).toBe(200);
    const cookieHeader = login.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Strict");
    const cookiePair = cookieHeader.split(";")[0]!;

    // Cookie grants access to /api/status.
    const statusRes = await fetch(`${running.url}/api/status`, {
      headers: { cookie: cookiePair },
    });
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as { phase: string; configured: boolean };
    expect(status.phase).toBe("unconfigured");
    expect(status.configured).toBe(false);

    // Changing password requires correct currentPassword and rotates session cookie.
    const badChange = await fetch(`${running.url}/api/auth/password`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: cookiePair },
      body: JSON.stringify({ currentPassword: "wrong", newPassword: "new-password-2" }),
    });
    expect(badChange.status).toBe(401);

    const goodChange = await fetch(`${running.url}/api/auth/password`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: cookiePair },
      body: JSON.stringify({ currentPassword: "my-custom-pass", newPassword: "new-password-2" }),
    });
    expect(goodChange.status).toBe(200);
    const rotatedCookie = (goodChange.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(
      (await fetch(`${running.url}/api/status`, { headers: { cookie: cookiePair } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${running.url}/api/status`, { headers: { cookie: rotatedCookie } })).status,
    ).toBe(200);

    // Static assets negotiate pre-compressed gzip and block path traversal.
    const jsRes = await fetch(`${running.url}/static/app.js`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("cache-control")).toContain("immutable");
    expect(await jsRes.text()).toContain("rome-node-web");

    const spaRes = await fetch(`${running.url}/audit`);
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toContain("Rome Node Web");

    const traversal = await fetch(`${running.url}/%2e%2e/package.json`);
    expect([403, 404]).toContain(traversal.status);

    // Removing password restores localhost passwordless mode.
    const removeRes = await fetch(`${running.url}/api/auth/password`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: rotatedCookie },
      body: JSON.stringify({ currentPassword: "new-password-2" }),
    });
    expect(removeRes.status).toBe(200);
    expect(running.authRequired).toBe(false);
    expect(running.passwordSource).toBe("none");
    expect((await fetch(`${running.url}/api/status`)).status).toBe(200);
  });

  it("handles full host lifecycle: device-code auth, exec + audit, limited mode toggle, disconnect/reconnect, and revocation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "rome-node-web-e2e-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    const assetsDir = await createAssetsFixture();
    const mock = await createMockCloudAndGateway();

    const running = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: configDir,
      cloudUrl: mock.cloudUrl,
      name: "Test Container",
      assetsDir,
      computerUse: { enabled: true, appPath: join(configDir, "missing.app") },
      log: () => {},
    });
    cleanup.push(() => running.close());

    expect(running.authRequired).toBe(false);

    // Start device code authorization and verify no secrets leak in the response.
    const authRes = await fetch(`${running.url}/api/host/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cloudUrl: mock.cloudUrl, name: "Test Container" }),
    });
    expect(authRes.status).toBe(200);
    const authBody = (await authRes.json()) as {
      phase: string;
      pendingAuth: { userCode: string; verificationUriComplete: string } | null;
    };
    expect(authBody.phase).toBe("authorizing");
    expect(authBody.pendingAuth?.userCode).toBe("ROME-2026");
    expect(JSON.stringify(authBody)).not.toContain("secret-device-code-never-expose");
    expect(JSON.stringify(authBody)).not.toContain(mock.token);

    // Approve in mock cloud and wait for host to reach online state.
    mock.approve();
    await until(async () => {
      const res = await fetch(`${running.url}/api/status`);
      const body = (await res.json()) as { phase: string };
      return body.phase === "online";
    });

    const info = await mock.sendRpc("system.info", {});
    expect(info).toMatchObject({
      result: {
        actions: ["system.info", "exec", "fs.list"],
        capabilities: [{ id: "computer_use", prefix: "computer", state: "off", personal: true }],
      },
    });
    expect(info).not.toHaveProperty("result.computerUse");
    expect(await mock.sendRpc("computer.windows", {})).toMatchObject({
      error: {
        code:
          process.platform === "darwin"
            ? "computer_use_helper_missing"
            : "computer_use_unsupported_platform",
      },
    });

    // Credential file is persisted on disk.
    const savedCred = JSON.parse(await readFile(join(configDir, "credential.json"), "utf8")) as {
      deviceId: string;
    };
    expect(savedCred.deviceId).toBe(mock.deviceId);

    // Run a remote exec and verify /api/status reflects healthy audit recording.
    const execReply = await mock.sendRpc("exec", {
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello-rome')"],
    });
    expect(execReply.ok).toBe(true);

    const statusAfterExec = (await (await fetch(`${running.url}/api/status`)).json()) as {
      audit: { status: { state: string }; requests: number; bytes: number };
    };
    expect(statusAfterExec.audit.status.state).toBe("ok");
    expect(statusAfterExec.audit.requests).toBeGreaterThanOrEqual(1);
    expect(statusAfterExec.audit.bytes).toBeGreaterThan(0);

    // Simulate config persistence failure while toggling execution OFF:
    // executionEnabled must remain true and a retry after recovery must succeed.
    const configFile = join(configDir, "web-config.json");
    await rm(configFile, { force: true });
    await mkdir(configFile);
    const failedToggle = await fetch(`${running.url}/api/host/execution`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(failedToggle.status).toBe(500);
    const statusAfterFailure = (await (await fetch(`${running.url}/api/status`)).json()) as {
      executionEnabled: boolean;
    };
    expect(statusAfterFailure.executionEnabled).toBe(true);
    await rm(configFile, { recursive: true, force: true });

    // Switch remote execution OFF -> reconnects in limited mode and refuses exec.
    const prevConnections = mock.getConnections();
    const toggleOff = await fetch(`${running.url}/api/host/execution`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggleOff.status).toBe(200);
    await until(async () => {
      const res = await fetch(`${running.url}/api/status`);
      const body = (await res.json()) as { phase: string; executionEnabled: boolean };
      return (
        body.phase === "online" && !body.executionEnabled && mock.getConnections() > prevConnections
      );
    });

    const refused = (await mock.sendRpc("exec", { command: "echo", args: ["hi"] })) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("computer_use_off");
    expect(await mock.sendRpc("system.info", {})).toMatchObject({
      result: { computerUse: false, actions: [] },
    });

    expect(await mock.sendRpc("computer.windows", {})).toMatchObject({
      error: { code: "computer_use_off" },
    });

    // Disconnect keeps credentials; connect restores online state.
    const disc = await fetch(`${running.url}/api/host/disconnect`, { method: "POST" });
    expect(disc.status).toBe(200);
    const discBody = (await disc.json()) as { phase: string; configured: boolean };
    expect(discBody.phase).toBe("disconnected");
    expect(discBody.configured).toBe(true);

    const reconn = await fetch(`${running.url}/api/host/connect`, { method: "POST" });
    expect(reconn.status).toBe(200);
    await until(async () => {
      const res = await fetch(`${running.url}/api/status`);
      const body = (await res.json()) as { phase: string };
      return body.phase === "online";
    });

    // Revocation (4001) keeps Web UI alive in `revoked` phase.
    mock.getSocket()?.close(4001, "revoked");
    await until(async () => {
      const res = await fetch(`${running.url}/api/status`);
      const body = (await res.json()) as { phase: string };
      return body.phase === "revoked";
    });

    // Clear credentials returns to unconfigured.
    const cleared = await fetch(`${running.url}/api/host/credentials/clear`, { method: "POST" });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as { phase: string; configured: boolean };
    expect(clearedBody.phase).toBe("unconfigured");
    expect(clearedBody.configured).toBe(false);
  });

  it("blocks DNS rebinding on auth-free loopback mode, rejects Bearer auth, and sends strict script-src CSP", async () => {
    function rawRequest(
      port: number,
      method: string,
      path: string,
      headers: Record<string, string>,
      body?: string,
    ): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
      return new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    }

    const configDir = await mkdtemp(join(tmpdir(), "rome-node-web-dns-rebind-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    const assetsDir = await createAssetsFixture();

    const loopbackServer = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: configDir,
      assetsDir,
      log: () => {},
    });
    cleanup.push(() => loopbackServer.close());

    // Rebound attacker domain with matching Host, Origin, and Sec-Fetch-Site must be rejected everywhere.
    const rebindHeaders = {
      host: `evil.example:${loopbackServer.port}`,
      origin: `http://evil.example:${loopbackServer.port}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const rebindRead = await rawRequest(loopbackServer.port, "GET", "/api/status", rebindHeaders);
    expect(rebindRead.status).toBe(403);
    const rebindEvents = await rawRequest(loopbackServer.port, "GET", "/api/events", rebindHeaders);
    expect(rebindEvents.status).toBe(403);
    const rebindMutate = await rawRequest(
      loopbackServer.port,
      "POST",
      "/api/host/execution",
      rebindHeaders,
      JSON.stringify({ enabled: false }),
    );
    expect(rebindMutate.status).toBe(403);
    const rebindHtml = await rawRequest(loopbackServer.port, "GET", "/", {
      host: `evil.example:${loopbackServer.port}`,
    });
    expect(rebindHtml.status).toBe(403);

    // Cross-origin API read on loopback must also be rejected.
    const crossOriginRead = await rawRequest(loopbackServer.port, "GET", "/api/status", {
      host: `127.0.0.1:${loopbackServer.port}`,
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(crossOriginRead.status).toBe(403);

    // Reverse-proxied non-loopback X-Forwarded-Host / X-Forwarded-For must be rejected when passwordless.
    const forwardedHost = await rawRequest(loopbackServer.port, "GET", "/api/status", {
      host: `127.0.0.1:${loopbackServer.port}`,
      "x-forwarded-host": "node.example.com",
    });
    expect(forwardedHost.status).toBe(403);
    const forwardedFor = await rawRequest(loopbackServer.port, "GET", "/api/status", {
      host: `127.0.0.1:${loopbackServer.port}`,
      "x-forwarded-for": "203.0.113.42",
    });
    expect(forwardedFor.status).toBe(403);

    // Valid loopback Host passes and carries strict CSP without unsafe-inline in script-src.
    const validLocalhost = await rawRequest(loopbackServer.port, "GET", "/api/status", {
      host: `localhost:${loopbackServer.port}`,
      origin: `http://localhost:${loopbackServer.port}`,
      "sec-fetch-site": "same-origin",
    });
    expect(validLocalhost.status).toBe(200);
    const csp = String(validLocalhost.headers["content-security-policy"] ?? "");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");

    // Env-password server allows remote Host with cookie login, blocks Bearer bypass, and returns 409 on password edit.
    const authConfigDir = await mkdtemp(join(tmpdir(), "rome-node-web-bearer-"));
    cleanup.push(() => rm(authConfigDir, { recursive: true, force: true }));
    const authServer = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: authConfigDir,
      assetsDir,
      password: "fixed-secret-password",
      log: () => {},
    });
    cleanup.push(() => authServer.close());

    expect(authServer.passwordSource).toBe("env");
    const bearerAttempt = await fetch(`${authServer.url}/api/status`, {
      headers: { authorization: "Bearer fixed-secret-password" },
    });
    expect(bearerAttempt.status).toBe(401);

    const loginRes = await fetch(`${authServer.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "fixed-secret-password" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const editEnvPass = await fetch(`${authServer.url}/api/auth/password`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ newPassword: "another-password" }),
    });
    expect(editEnvPass.status).toBe(409);

    // Remote Host works once password is set.
    const remoteRead = await rawRequest(authServer.port, "GET", "/api/status", {
      host: `node.example.com:${authServer.port}`,
      cookie,
    });
    expect(remoteRead.status).toBe(200);
  });

  it("requires one-time setup token on 0.0.0.0 bind even with forged Host header and forbids removing password", async () => {
    function rawRequest(
      port: number,
      method: string,
      path: string,
      headers: Record<string, string>,
      body?: string,
    ): Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> {
      return new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    }

    const configDir = await mkdtemp(join(tmpdir(), "rome-node-web-setup-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    const assetsDir = await createAssetsFixture();
    const logs: string[] = [];

    const nonLoopback = await startWebServer({
      host: "0.0.0.0",
      port: 0,
      configDirectory: configDir,
      assetsDir,
      log: (line) => logs.push(line),
    });
    cleanup.push(() => nonLoopback.close());

    expect(nonLoopback.authRequired).toBe(true);
    expect(nonLoopback.passwordSource).toBe("setup");
    expect(nonLoopback.setupToken).toBeTruthy();
    const printedTokenLine = logs.find((line) => line.startsWith("Web UI setup token: "));
    expect(printedTokenLine).toBe(`Web UI setup token: ${nonLoopback.setupToken}`);
    const setupToken = nonLoopback.setupToken!;

    // Forged Host: 127.0.0.1 + Sec-Fetch-Site: same-origin MUST NOT bypass auth on a 0.0.0.0 bind.
    const forgedHeaders = {
      host: `127.0.0.1:${nonLoopback.port}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    expect((await rawRequest(nonLoopback.port, "GET", "/api/status", forgedHeaders)).status).toBe(
      401,
    );
    expect(
      (
        await rawRequest(
          nonLoopback.port,
          "POST",
          "/api/host/authorize",
          forgedHeaders,
          JSON.stringify({ cloudUrl: "https://attacker.example", name: "pwned" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await rawRequest(
          nonLoopback.port,
          "PUT",
          "/api/auth/password",
          forgedHeaders,
          JSON.stringify({ newPassword: "attacker-password" }),
        )
      ).status,
    ).toBe(401);

    // Login before initial setup returns 409; wrong setup token returns 401.
    expect(
      (
        await rawRequest(
          nonLoopback.port,
          "POST",
          "/api/auth/login",
          forgedHeaders,
          JSON.stringify({ password: setupToken }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await rawRequest(
          nonLoopback.port,
          "POST",
          "/api/auth/setup",
          forgedHeaders,
          JSON.stringify({ token: "wrong-token", newPassword: "owner-password-1" }),
        )
      ).status,
    ).toBe(401);

    // Valid one-time setup token sets the password, issues a session cookie, and burns the token.
    const setupRes = await rawRequest(
      nonLoopback.port,
      "POST",
      "/api/auth/setup",
      forgedHeaders,
      JSON.stringify({ token: setupToken, newPassword: "owner-password-1" }),
    );
    expect(setupRes.status).toBe(200);
    expect(nonLoopback.passwordSource).toBe("file");
    expect(nonLoopback.setupToken).toBeNull();
    const setCookieHeader = Array.isArray(setupRes.headers["set-cookie"])
      ? setupRes.headers["set-cookie"][0]
      : setupRes.headers["set-cookie"];
    const cookie = (setCookieHeader ?? "").split(";")[0]!;
    expect(cookie).toContain("rome_node_session=");

    // Reusing the setup token fails with 409.
    expect(
      (
        await rawRequest(
          nonLoopback.port,
          "POST",
          "/api/auth/setup",
          forgedHeaders,
          JSON.stringify({ token: setupToken, newPassword: "owner-password-2" }),
        )
      ).status,
    ).toBe(409);

    // Session works for /api/status, but DELETE /api/auth/password is forbidden on 0.0.0.0 even with forged Host.
    expect(
      (await rawRequest(nonLoopback.port, "GET", "/api/status", { ...forgedHeaders, cookie }))
        .status,
    ).toBe(200);
    const deleteAttempt = await rawRequest(
      nonLoopback.port,
      "DELETE",
      "/api/auth/password",
      { ...forgedHeaders, cookie },
      JSON.stringify({ currentPassword: "owner-password-1" }),
    );
    expect(deleteAttempt.status).toBe(403);
  });

  it("does not launch host if cancelled or disposed during credential save, reports final config save failures, and preserves concurrent executionEnabled updates", async () => {
    const validToken = `romedev_${"c".repeat(43)}`;

    // 1. Cancel during credentials.save must NOT launch a host connection now OR after restart.
    {
      const configDir = await mkdtemp(join(tmpdir(), "rome-node-cancel-save-"));
      cleanup.push(() => rm(configDir, { recursive: true, force: true }));
      const fileCredentials = createFileCredentialStore(join(configDir, "credential.json"));
      let releaseSave!: () => void;
      const saveEntered = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let finishSave!: () => void;
      const saveGate = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      let connectCalls = 0;

      const controller = new HostController({
        configDirectory: configDir,
        cloudUrl: "https://romeos.cc",
        name: "Cancel During Save",
        deps: {
          credentials: {
            load: () => fileCredentials.load(),
            save: async (credential) => {
              releaseSave();
              await saveGate;
              await fileCredentials.save(credential);
            },
            clear: () => fileCredentials.clear(),
          },
          loginDeviceCode: async (_cloud, _name, _signal, onPrompt) => {
            onPrompt({
              verificationUri: "https://romeos.cc/device",
              verificationUriComplete: "https://romeos.cc/device?user_code=TEST-1111",
              userCode: "TEST-1111",
              expiresIn: 300,
            });
            return { cloudUrl: "https://romeos.cc", token: validToken, deviceId: "dev-cancel-1" };
          },
          connectHost: async () => {
            connectCalls += 1;
          },
          connectLimitedHost: async () => {
            connectCalls += 1;
          },
        },
      });
      cleanup.push(() => controller.dispose());
      await controller.start();

      await controller.authorize();
      await saveEntered;
      const cancelPromise = controller.cancelAuthorization();
      finishSave();
      const afterCancel = await cancelPromise;

      expect(afterCancel.configured).toBe(true);
      expect(afterCancel.deviceId).toBe("dev-cancel-1");
      expect(afterCancel.phase).toBe("disconnected");
      expect(connectCalls).toBe(0);
      await controller.dispose();

      // Restarting against the same directory must stay disconnected and NOT auto-launch execution.
      let restartedConnectCalls = 0;
      const restarted = new HostController({
        configDirectory: configDir,
        cloudUrl: "https://romeos.cc",
        name: "Cancel During Save",
        deps: {
          connectHost: async () => {
            restartedConnectCalls += 1;
          },
          connectLimitedHost: async () => {
            restartedConnectCalls += 1;
          },
        },
      });
      cleanup.push(() => restarted.dispose());
      await restarted.start();
      expect(restarted.snapshot().configured).toBe(true);
      expect(restarted.snapshot().deviceId).toBe("dev-cancel-1");
      expect(restarted.snapshot().phase).toBe("disconnected");
      expect(restartedConnectCalls).toBe(0);
    }

    // 2. dispose() during credentials.save must NOT launch host or use closed audit store.
    {
      const configDir = await mkdtemp(join(tmpdir(), "rome-node-dispose-save-"));
      cleanup.push(() => rm(configDir, { recursive: true, force: true }));
      let notifySaveEntered!: () => void;
      const saveEntered = new Promise<void>((resolve) => {
        notifySaveEntered = resolve;
      });
      let finishSave!: () => void;
      const saveGate = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      let connectCalls = 0;

      const controller = new HostController({
        configDirectory: configDir,
        cloudUrl: "https://romeos.cc",
        name: "Dispose During Save",
        deps: {
          credentials: {
            load: async () => null,
            save: async () => {
              notifySaveEntered();
              await saveGate;
            },
            clear: async () => {},
          },
          loginDeviceCode: async (_cloud, _name, _signal, onPrompt) => {
            onPrompt({
              verificationUri: "https://romeos.cc/device",
              verificationUriComplete: "https://romeos.cc/device?user_code=TEST-2222",
              userCode: "TEST-2222",
              expiresIn: 300,
            });
            return { cloudUrl: "https://romeos.cc", token: validToken, deviceId: "dev-dispose-1" };
          },
          connectHost: async () => {
            connectCalls += 1;
          },
          connectLimitedHost: async () => {
            connectCalls += 1;
          },
        },
      });
      await controller.start();

      await controller.authorize();
      await saveEntered;
      const disposePromise = controller.dispose();
      finishSave();
      await disposePromise;

      expect(connectCalls).toBe(0);
    }

    // 3. Final saveConfig failure after credential save must transition to phase: "error" with lastError.
    {
      const configDir = await mkdtemp(join(tmpdir(), "rome-node-save-config-fail-"));
      cleanup.push(() => rm(configDir, { recursive: true, force: true }));
      let connectCalls = 0;
      let stored: HostCredential | null = null;

      const controller = new HostController({
        configDirectory: configDir,
        cloudUrl: "https://romeos.cc",
        name: "Config Fail",
        deps: {
          credentials: {
            load: async () => stored,
            save: async (cred) => {
              stored = cred;
              // Sabotage web-config.json so the final saveConfig fails with EISDIR.
              const configPath = join(configDir, "web-config.json");
              await rm(configPath, { force: true });
              await mkdir(configPath);
            },
            clear: async () => {
              stored = null;
            },
          },
          loginDeviceCode: async (_cloud, _name, _signal, onPrompt) => {
            onPrompt({
              verificationUri: "https://romeos.cc/device",
              verificationUriComplete: "https://romeos.cc/device?user_code=TEST-3333",
              userCode: "TEST-3333",
              expiresIn: 300,
            });
            return { cloudUrl: "https://romeos.cc", token: validToken, deviceId: "dev-fail-1" };
          },
          connectHost: async () => {
            connectCalls += 1;
          },
          connectLimitedHost: async () => {
            connectCalls += 1;
          },
        },
      });
      cleanup.push(() => controller.dispose());
      await controller.start();

      await controller.authorize();
      await until(() => controller.snapshot().phase === "error");

      const snap = controller.snapshot();
      expect(snap.phase).toBe("error");
      expect(snap.pendingAuth).toBeNull();
      expect(snap.lastError).toBeTruthy();
      expect(connectCalls).toBe(0);
    }

    // 4. Concurrent setExecutionEnabled(false) during credentials.save must not be overwritten by authorize completion.
    {
      const configDir = await mkdtemp(join(tmpdir(), "rome-node-concurrent-exec-"));
      cleanup.push(() => rm(configDir, { recursive: true, force: true }));
      let notifySaveEntered!: () => void;
      const saveEntered = new Promise<void>((resolve) => {
        notifySaveEntered = resolve;
      });
      let finishSave!: () => void;
      const saveGate = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      let fullHostCalls = 0;
      let limitedHostCalls = 0;
      let stored: HostCredential | null = null;

      const controller = new HostController({
        configDirectory: configDir,
        cloudUrl: "https://romeos.cc",
        name: "Concurrent Exec",
        deps: {
          credentials: {
            load: async () => stored,
            save: async (cred) => {
              stored = cred;
              notifySaveEntered();
              await saveGate;
            },
            clear: async () => {
              stored = null;
            },
          },
          loginDeviceCode: async (_cloud, _name, _signal, onPrompt) => {
            onPrompt({
              verificationUri: "https://romeos.cc/device",
              verificationUriComplete: "https://romeos.cc/device?user_code=TEST-4444",
              userCode: "TEST-4444",
              expiresIn: 300,
            });
            return { cloudUrl: "https://romeos.cc", token: validToken, deviceId: "dev-exec-1" };
          },
          connectHost: async () => {
            fullHostCalls += 1;
          },
          connectLimitedHost: async ({ signal, onEvent }) => {
            limitedHostCalls += 1;
            onEvent?.({ type: "connection", status: "online" });
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        },
      });
      cleanup.push(() => controller.dispose());
      await controller.start();

      await controller.authorize();
      await saveEntered;
      await controller.setExecutionEnabled(false);
      finishSave();

      await until(() => controller.snapshot().phase === "online");
      expect(fullHostCalls).toBe(0);
      expect(limitedHostCalls).toBe(1);
      expect(controller.snapshot().executionEnabled).toBe(false);
      const persistedConfig = JSON.parse(
        await readFile(join(configDir, "web-config.json"), "utf8"),
      ) as { executionEnabled: boolean };
      expect(persistedConfig.executionEnabled).toBe(false);
    }
  });

  it("enforces login rate limit across concurrent wrong-password attempts and fails closed on corrupted web-auth.json", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "rome-node-web-ratelimit-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    const assetsDir = await createAssetsFixture();

    const web = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: configDir,
      assetsDir,
      password: "correct-horse-battery",
      log: () => {},
    });
    cleanup.push(() => web.close());

    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        fetch(`${web.url}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "wrong-password" }),
        }),
      ),
    );
    const statuses = responses.map((res) => res.status);
    const unauthorizedCount = statuses.filter((status) => status === 401).length;
    const rateLimitedCount = statuses.filter((status) => status === 429).length;
    expect(unauthorizedCount).toBeLessThanOrEqual(5);
    expect(rateLimitedCount).toBeGreaterThanOrEqual(20);
    expect(unauthorizedCount + rateLimitedCount).toBe(25);

    const followUp = await fetch(`${web.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(followUp.status).toBe(429);
    expect(Number(followUp.headers.get("retry-after"))).toBeGreaterThanOrEqual(25);
    const followUpBody = (await followUp.json()) as { error?: string; retryAfterSeconds?: number };
    expect(followUpBody.retryAfterSeconds).toBeGreaterThanOrEqual(25);
    expect(followUpBody.error).toMatch(/Try again in \d+s\./);

    // Deterministic exponential backoff ladder: 5 free attempts -> 30s -> 60s -> 120s -> 240s -> 480s -> 900s cap.
    let fakeNow = 1_000_000;
    const auth = await createWebAuth({
      host: "127.0.0.1",
      password: "correct-horse-battery",
      now: () => fakeNow,
    });
    const ip = "203.0.113.10";
    for (let i = 0; i < 5; i += 1) {
      const attempt = auth.reserveLoginAttempt(ip);
      expect(attempt.allowed).toBe(true);
      if (attempt.allowed) attempt.finish("failure");
    }
    const expectedCooldowns = [30, 60, 120, 240, 480, 900, 900];
    for (let i = 0; i < expectedCooldowns.length; i += 1) {
      const blocked = auth.reserveLoginAttempt(ip);
      expect(blocked).toEqual({ allowed: false, retryAfterSeconds: expectedCooldowns[i] });
      fakeNow += expectedCooldowns[i]! * 1000;
      // After cooldown expires, only 1 concurrent probe is allowed at a time.
      const probe = auth.reserveLoginAttempt(ip);
      expect(probe.allowed).toBe(true);
      expect(auth.reserveLoginAttempt(ip)).toEqual({ allowed: false, retryAfterSeconds: 1 });
      if (probe.allowed) {
        if (i < expectedCooldowns.length - 1) {
          probe.finish("failure");
        } else {
          probe.finish("success");
        }
      }
    }
    // After a successful attempt, cooldown and failure streak are cleared.
    const postSuccess = auth.reserveLoginAttempt(ip);
    expect(postSuccess.allowed).toBe(true);
    if (postSuccess.allowed) postSuccess.finish("abort");

    const corruptedDir = await mkdtemp(join(tmpdir(), "rome-node-corrupt-auth-"));
    cleanup.push(() => rm(corruptedDir, { recursive: true, force: true }));
    await writeFile(join(corruptedDir, "web-auth.json"), "{not-valid-json", "utf8");
    await expect(
      createWebAuth({ host: "127.0.0.1", configDirectory: corruptedDir }),
    ).rejects.toThrow(/corrupted/i);

    await writeFile(
      join(corruptedDir, "web-auth.json"),
      JSON.stringify({ version: 1, salt: "short", hash: "bad" }),
      "utf8",
    );
    await expect(
      createWebAuth({ host: "127.0.0.1", configDirectory: corruptedDir }),
    ).rejects.toThrow(/invalid format/i);
  });

  it("serves read-only /api/audit/* endpoints with auth, same-origin, sanitization, pagination, and bounded content previews", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "rome-node-web-audit-api-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    const assetsDir = await createAssetsFixture();

    // Anchor timestamps inside the last 8 hours so 30-day retention keeps every seeded record.
    const baseTime = Math.floor((Date.now() - 8 * 60 * 60 * 1000) / 3_600_000) * 3_600_000;
    let seedTime = baseTime;
    const auditPath = join(configDir, "audit", "audit.db");
    const writer = await AuditStore.open({
      path: auditPath,
      entry: "cli",
      hint: "Run rome-node audit status.",
      now: () => seedTime,
    });

    // Record 1: successful exec with stdin + stdout
    seedTime = baseTime + 1_000;
    const seqExecOk = await writer.start(
      "exec",
      {
        requestId: "req-exec-ok",
        from: "caller-alpha",
        args: { command: "git", args: ["status", "--short"], cwd: "/workspace/needle-project" },
        envKeys: ["PATH", "NODE_ENV"],
      },
      { stdin: Buffer.from("hello stdin\n", "utf8") },
    );
    expect(seqExecOk).not.toBeNull();
    seedTime = baseTime + 1_250;
    writer.end(
      seqExecOk!,
      "exec",
      "ok",
      { exitCode: 0, durationMs: 250, pid: 1001 },
      { stdout: Buffer.from("M README.md\n", "utf8") },
    );

    // Record 2: failed exec with > 256 KiB stderr where a 3-byte UTF-8 char straddles 256 KiB
    seedTime = baseTime + 60 * 60 * 1000;
    const seqExecFail = await writer.start("exec", {
      requestId: "req-exec-fail",
      from: "caller-beta",
      args: { command: "npm", args: ["test"], cwd: "/workspace/app" },
    });
    expect(seqExecFail).not.toBeNull();
    const boundaryPrefix = Buffer.alloc(256 * 1024 - 1, 0x61); // 'a' * (256KiB - 1)
    const multiByte = Buffer.from("中tail", "utf8"); // '中' is 3 bytes: 1 byte inside 256KiB, 2 bytes outside
    const hugeStderr = Buffer.concat([boundaryPrefix, multiByte]);
    writer.end(
      seqExecFail!,
      "exec",
      "exit_nonzero",
      { exitCode: 2, durationMs: 900 },
      { stderr: hugeStderr },
    );

    // Record 3: fs.list with entries array (must be projected to entriesCount, never exposing entries)
    seedTime = baseTime + 2 * 60 * 60 * 1000;
    const seqFsList = await writer.start("fs.list", {
      requestId: "req-fs-list",
      args: { path: "/workspace/secret-dir" },
    });
    expect(seqFsList).not.toBeNull();
    writer.end(seqFsList!, "fs.list", "ok", {
      durationMs: 12,
      entries: [{ name: "secret-a.txt" }, { name: "secret-b.txt" }, { name: "secret-c.txt" }],
    });

    // Record 4: transfer.open push with binary file content (contains NUL byte)
    seedTime = baseTime + 3 * 60 * 60 * 1000;
    const seqTransfer = await writer.start("transfer.open", {
      requestId: "req-transfer-bin",
      args: { direction: "push", path: "/tmp/archive.bin" },
    });
    expect(seqTransfer).not.toBeNull();
    const binaryPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
    writer.end(
      seqTransfer!,
      "transfer.open",
      "ok",
      { durationMs: 45, bytes: binaryPayload.byteLength, path: "/tmp/archive.bin" },
      { file: binaryPayload },
    );

    // Record 5: exec with pruned stdout content + Record 6: no_result (no end record)
    seedTime = baseTime + 4 * 60 * 60 * 1000;
    const seqPruned = await writer.start("exec", {
      requestId: "req-pruned",
      args: { command: "cat", args: ["old.log"] },
    });
    expect(seqPruned).not.toBeNull();
    writer.end(
      seqPruned!,
      "exec",
      "ok",
      { exitCode: 0, durationMs: 5 },
      { stdout: Buffer.from("will be pruned", "utf8") },
    );

    seedTime = baseTime + 5 * 60 * 60 * 1000;
    const seqNoResult = await writer.start("exec", {
      requestId: "req-no-result",
      args: { command: "sleep", args: ["999"] },
    });
    expect(seqNoResult).not.toBeNull();

    writer.close();

    // Simulate pruned content blob for seqPruned's end record directly in SQLite.
    const rawDb = new DatabaseSync(auditPath);
    rawDb
      .prepare(
        "DELETE FROM content WHERE name = 'stdout' AND seq IN (SELECT seq FROM events WHERE start_seq = ?)",
      )
      .run(seqPruned!);
    rawDb.close();

    const web = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: configDir,
      assetsDir,
      password: "audit-secret-password",
      log: () => {},
    });
    cleanup.push(() => web.close());

    // 1. Unauthenticated requests are rejected with 401.
    expect((await fetch(`${web.url}/api/audit/summary`)).status).toBe(401);
    expect((await fetch(`${web.url}/api/audit/items`)).status).toBe(401);

    // Log in to get a session cookie.
    const loginRes = await fetch(`${web.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "audit-secret-password" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;

    // 2. Cross-origin GET on /api/audit/* is rejected with 403 even with a valid session cookie.
    const crossOriginAudit = await fetch(`${web.url}/api/audit/summary`, {
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossOriginAudit.status).toBe(403);

    // 3. Non-GET methods are rejected with 405 and Allow: GET.
    const postAudit = await fetch(`${web.url}/api/audit/items`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(postAudit.status).toBe(405);
    expect(postAudit.headers.get("allow")).toBe("GET");

    // 4. GET /api/audit/summary returns sanitized summary + counts without exposing local DB path.
    const summaryRes = await fetch(`${web.url}/api/audit/summary`, { headers: { cookie } });
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.headers.get("cache-control")).toBe("no-store");
    expect(summaryRes.headers.get("x-content-type-options")).toBe("nosniff");
    const summaryBody = (await summaryRes.json()) as {
      status: { state: string };
      requests: number;
      counts: { all: number; succeeded: number; failed: number; no_result: number } | null;
      path?: string;
    };
    expect(summaryBody.status).toEqual({ state: "ok" });
    expect(summaryBody.requests).toBe(6);
    expect(summaryBody.counts).toEqual({ all: 6, succeeded: 4, failed: 1, no_result: 1 });
    expect(summaryBody.path).toBeUndefined();
    expect(JSON.stringify(summaryBody)).not.toContain(configDir);

    // 5. GET /api/audit/stats returns bucketed stats and validates parameters.
    const statsRes = await fetch(
      `${web.url}/api/audit/stats?since=${baseTime}&until=${baseTime + 6 * 60 * 60 * 1000}&bucketMs=3600000`,
      { headers: { cookie } },
    );
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as {
      groups: { bucket: number; result: string; count: number }[];
    };
    const totalCount = statsBody.groups.reduce((sum, g) => sum + g.count, 0);
    expect(totalCount).toBe(6);

    expect((await fetch(`${web.url}/api/audit/stats`, { headers: { cookie } })).status).toBe(400);
    expect(
      (
        await fetch(
          `${web.url}/api/audit/stats?since=${baseTime + 100}&until=${baseTime}&bucketMs=60000`,
          { headers: { cookie } },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${web.url}/api/audit/stats?since=${baseTime}&until=${baseTime + 3600000}&bucketMs=1000`,
          { headers: { cookie } },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${web.url}/api/audit/stats?since=0&until=${1001 * 60_000}&bucketMs=60000`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(400);

    // 6. GET /api/audit/items supports pagination, filtering, text search, and projects fs.list safely.
    const page1Res = await fetch(`${web.url}/api/audit/items?limit=4`, { headers: { cookie } });
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      items: {
        seq: number;
        kind: string;
        action: string;
        end: { record: Record<string, unknown> } | null;
      }[];
      hasMore: boolean;
    };
    expect(page1.items).toHaveLength(4);
    expect(page1.hasMore).toBe(true);
    expect(page1.items.every((item) => item.kind === "start")).toBe(true);

    const fsListItem = page1.items.find((item) => item.seq === seqFsList);
    expect(fsListItem?.end?.record.entriesCount).toBe(3);
    expect(fsListItem?.end?.record.entries).toBeUndefined();
    expect(JSON.stringify(fsListItem)).not.toContain("secret-a.txt");

    const oldestSeqPage1 = page1.items[page1.items.length - 1]!.seq;
    const page2Res = await fetch(`${web.url}/api/audit/items?limit=4&beforeSeq=${oldestSeqPage1}`, {
      headers: { cookie },
    });
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as { items: { seq: number }[]; hasMore: boolean };
    expect(page2.items).toHaveLength(2);
    expect(page2.hasMore).toBe(false);

    // Filter by result
    const failedRes = await fetch(`${web.url}/api/audit/items?result=failed`, {
      headers: { cookie },
    });
    const failedBody = (await failedRes.json()) as { items: { seq: number }[] };
    expect(failedBody.items.map((item) => item.seq)).toEqual([seqExecFail]);

    const noResultRes = await fetch(`${web.url}/api/audit/items?result=no_result`, {
      headers: { cookie },
    });
    const noResultBody = (await noResultRes.json()) as { items: { seq: number }[] };
    expect(noResultBody.items.map((item) => item.seq)).toEqual([seqNoResult]);

    // Filter by text
    const searchRes = await fetch(`${web.url}/api/audit/items?text=needle-project`, {
      headers: { cookie },
    });
    const searchBody = (await searchRes.json()) as { items: { seq: number }[] };
    expect(searchBody.items.map((item) => item.seq)).toEqual([seqExecOk]);

    // Invalid list parameters
    expect(
      (await fetch(`${web.url}/api/audit/items?limit=201`, { headers: { cookie } })).status,
    ).toBe(400);
    expect(
      (await fetch(`${web.url}/api/audit/items?result=bogus`, { headers: { cookie } })).status,
    ).toBe(400);
    expect(
      (await fetch(`${web.url}/api/audit/items?text=${"x".repeat(257)}`, { headers: { cookie } }))
        .status,
    ).toBe(400);

    // 7. GET /api/audit/items/:seq returns detail for start records, 404 for host/missing records, 400 for invalid seq.
    const detailRes = await fetch(`${web.url}/api/audit/items/${seqExecOk}`, {
      headers: { cookie },
    });
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      item: { seq: number; record: { envKeys?: string[]; from?: string } };
    };
    expect(detailBody.item.seq).toBe(seqExecOk);
    expect(detailBody.item.record.from).toBe("caller-alpha");
    expect(detailBody.item.record.envKeys).toEqual(["PATH", "NODE_ENV"]);

    // Seq 1 is the internal `host` record — must never be exposed.
    expect((await fetch(`${web.url}/api/audit/items/1`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${web.url}/api/audit/items/99999`, { headers: { cookie } })).status).toBe(
      404,
    );
    expect((await fetch(`${web.url}/api/audit/items/abc`, { headers: { cookie } })).status).toBe(
      400,
    );
    expect(
      (await fetch(`${web.url}/api/audit/items/%E0%A4%A`, { headers: { cookie } })).status,
    ).toBe(400);

    // 8. GET /api/audit/items/:seq/content/:name: text, bounded truncation with UTF-8 boundary, binary, pruned, 404, 400.
    const stdoutRes = await fetch(`${web.url}/api/audit/items/${seqExecOk}/content/stdout`, {
      headers: { cookie },
    });
    expect(stdoutRes.status).toBe(200);
    expect(await stdoutRes.json()).toMatchObject({
      seq: seqExecOk,
      name: "stdout",
      available: true,
      truncated: false,
      isBinary: false,
      text: "M README.md\n",
    });

    const stdinRes = await fetch(
      `${web.url}/api/audit/items/${seqExecOk}/content/stdin?maxBytes=5`,
      {
        headers: { cookie },
      },
    );
    expect(stdinRes.status).toBe(200);
    expect(await stdinRes.json()).toMatchObject({
      seq: seqExecOk,
      name: "stdin",
      available: true,
      truncated: true,
      previewBytes: 5,
      isBinary: false,
      text: "hello",
    });

    // Huge stderr: bounded at 256 KiB and cleanly trims the incomplete 3-byte UTF-8 sequence at the end.
    const hugeRes = await fetch(`${web.url}/api/audit/items/${seqExecFail}/content/stderr`, {
      headers: { cookie },
    });
    expect(hugeRes.status).toBe(200);
    const hugeBody = (await hugeRes.json()) as {
      available: boolean;
      size: number;
      previewBytes: number;
      truncated: boolean;
      isBinary: boolean;
      text: string | null;
    };
    expect(hugeBody.available).toBe(true);
    expect(hugeBody.size).toBe(hugeStderr.byteLength);
    expect(hugeBody.previewBytes).toBe(256 * 1024 - 1);
    expect(hugeBody.truncated).toBe(true);
    expect(hugeBody.isBinary).toBe(false);
    expect(hugeBody.text).toHaveLength(256 * 1024 - 1);
    expect(hugeBody.text).not.toContain("\uFFFD");

    // Binary file content -> isBinary: true, text: null
    const binRes = await fetch(`${web.url}/api/audit/items/${seqTransfer}/content/file`, {
      headers: { cookie },
    });
    expect(binRes.status).toBe(200);
    expect(await binRes.json()).toMatchObject({
      seq: seqTransfer,
      name: "file",
      available: true,
      isBinary: true,
      text: null,
    });

    // Pruned content -> available: false, text: null
    const prunedRes = await fetch(`${web.url}/api/audit/items/${seqPruned}/content/stdout`, {
      headers: { cookie },
    });
    expect(prunedRes.status).toBe(200);
    expect(await prunedRes.json()).toMatchObject({
      seq: seqPruned,
      name: "stdout",
      available: false,
      text: null,
    });

    // Missing stream -> 404; invalid stream name / malformed encoding -> 400
    expect(
      (
        await fetch(`${web.url}/api/audit/items/${seqExecOk}/content/stderr`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${web.url}/api/audit/items/${seqExecOk}/content/bogus`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${web.url}/api/audit/items/${seqExecOk}/content/%E0%A4%A`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(400);
  });

  it("returns 503 when the audit database is unavailable and enforces /api/audit/* rate limiting", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "rome-node-web-audit-unavail-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    const assetsDir = await createAssetsFixture();

    await mkdir(join(configDir, "audit"), { recursive: true });
    await writeFile(join(configDir, "audit", "audit.db"), Buffer.from("not a sqlite db", "utf8"));

    let fakeNow = 2_000_000;
    const web = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: configDir,
      assetsDir,
      log: () => {},
      deps: { now: () => fakeNow },
    });
    cleanup.push(() => web.close());

    // Summary reports unavailable status cleanly with HTTP 200.
    const summaryRes = await fetch(`${web.url}/api/audit/summary`);
    expect(summaryRes.status).toBe(200);
    const summaryBody = (await summaryRes.json()) as {
      status: { state: string; code?: string };
      counts: unknown;
    };
    expect(summaryBody.status.state).toBe("unavailable");
    expect(summaryBody.status.code).toBe("unreadable");
    expect(summaryBody.counts).toBeNull();

    // Data endpoints fail closed with HTTP 503.
    const itemsRes = await fetch(`${web.url}/api/audit/items`);
    expect(itemsRes.status).toBe(503);
    expect(await itemsRes.json()).toMatchObject({
      status: { state: "unavailable", code: "unreadable" },
    });

    const statsRes = await fetch(`${web.url}/api/audit/stats?since=0&until=3600000&bucketMs=60000`);
    expect(statsRes.status).toBe(503);

    const detailRes = await fetch(`${web.url}/api/audit/items/1`);
    expect(detailRes.status).toBe(503);

    // Rate limit: 4 requests already consumed above; 596 more succeed, 601st gets 429 with Retry-After.
    for (let sent = 0; sent < 596; sent += 50) {
      const batch = Math.min(50, 596 - sent);
      const responses = await Promise.all(
        Array.from({ length: batch }, () => fetch(`${web.url}/api/audit/summary`)),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    }
    const limitedRes = await fetch(`${web.url}/api/audit/summary`);
    expect(limitedRes.status).toBe(429);
    expect(Number(limitedRes.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    // Advancing clock past the 60s window resets the limiter.
    fakeNow += 60_000;
    const afterWindow = await fetch(`${web.url}/api/audit/summary`);
    expect(afterWindow.status).toBe(200);
  });
});
