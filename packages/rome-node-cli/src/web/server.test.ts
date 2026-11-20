import { afterEach, describe, expect, it } from "@rstest/core";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { isLoopbackHost } from "./auth.js";
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

  it("enforces token auth, HttpOnly cookie session, CSRF check, and static gzip serving", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "rome-node-web-auth-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    const assetsDir = await createAssetsFixture();
    const logs: string[] = [];

    const running = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      configDirectory: configDir,
      assetsDir,
      requireAuth: true,
      log: (line) => logs.push(line),
    });
    cleanup.push(() => running.close());

    expect(running.authRequired).toBe(true);
    expect(running.initialToken).toBeTruthy();
    expect(logs.some((line) => line.includes(running.initialToken!))).toBe(true);

    // Health check works without authentication.
    const health = await fetch(`${running.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    // Unauthenticated API access is rejected.
    const unauth = await fetch(`${running.url}/api/status`);
    expect(unauth.status).toBe(401);

    // Cross-origin login is rejected.
    const csrf = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ token: running.initialToken }),
    });
    expect(csrf.status).toBe(403);

    // Wrong token fails with 401.
    const badLogin = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(badLogin.status).toBe(401);

    // Correct token issues HttpOnly SameSite=Strict cookie.
    const login = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: running.initialToken }),
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

    // Logout clears session.
    const logout = await fetch(`${running.url}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: cookiePair },
    });
    expect(logout.status).toBe(200);
    const afterLogout = await fetch(`${running.url}/api/status`, {
      headers: { cookie: cookiePair },
    });
    expect(afterLogout.status).toBe(401);
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

    // Credential file is persisted on disk.
    const savedCred = JSON.parse(await readFile(join(configDir, "credential.json"), "utf8")) as {
      deviceId: string;
    };
    expect(savedCred.deviceId).toBe(mock.deviceId);

    // Run a remote exec and verify audit API returns record + truncated stdout preview.
    const execReply = await mock.sendRpc("exec", {
      command: process.execPath,
      args: ["-e", "process.stdout.write('A'.repeat(300 * 1024))"],
    });
    expect(execReply.ok).toBe(true);

    const itemsRes = await fetch(`${running.url}/api/audit/items?limit=10`);
    expect(itemsRes.status).toBe(200);
    const { items } = (await itemsRes.json()) as { items: { seq: number; action: string }[] };
    expect(items.length).toBeGreaterThanOrEqual(1);
    const execItem = items.find((item) => item.action === "exec");
    expect(execItem).toBeTruthy();

    const contentRes = await fetch(
      `${running.url}/api/audit/items/${execItem!.seq}/content/stdout`,
    );
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("x-content-truncated")).toBe("true");
    expect(Number(contentRes.headers.get("x-content-total-bytes"))).toBe(300 * 1024);
    const previewBytes = new Uint8Array(await contentRes.arrayBuffer());
    expect(previewBytes.byteLength).toBe(256 * 1024);

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
});
