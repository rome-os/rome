import { afterEach, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { writePrivateJson } from "@rome-os/node-core/storage";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function fixture(
  options: {
    exchangeStatuses?: number[];
    validationFailures?: number;
    issuedToken?: string;
    listFailure?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "rome-node-daemon-"));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const token = `romedev_${"a".repeat(43)}`;
  const instanceToken = "romeinst_test";
  let lists = 0;
  let exchanges = 0;
  let configs = 0;
  const cloud = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/instance/gateway-credential") {
      exchanges++;
      const status = options.exchangeStatuses?.shift() ?? 200;
      if (req.method !== "POST" || req.headers.authorization !== `Bearer ${instanceToken}`)
        res.writeHead(401).end("{}");
      else if (status !== 200) res.writeHead(status).end(JSON.stringify({ error: instanceToken }));
      else res.end(JSON.stringify({ deviceToken: options.issuedToken ?? token }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: "invalid_device_session" }));
    } else if (req.url === "/v1/gateway/config") {
      configs++;
      if (configs <= (options.validationFailures ?? 0)) res.writeHead(503).end("{}");
      else res.end(JSON.stringify({ gatewayUrl: "wss://gateway.example/connect" }));
    } else if (req.url === "/api/account/devices") {
      lists++;
      if (options.listFailure) {
        res.writeHead(503).end("{}");
        return;
      }
      res.end(JSON.stringify({ items: [{ id: "target" }] }));
    } else res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => cloud.close(() => resolve())));
  const address = cloud.address();
  if (!address || typeof address === "string") throw new Error("Cloud did not start");
  const cloudUrl = `http://127.0.0.1:${address.port}`;
  const path = resolve("bin/rome-node.js");
  function cli(
    args: string[],
    input?: string,
    env: NodeJS.ProcessEnv = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path, ...args], {
        env: { ...process.env, ROME_NODE_CONFIG_DIR: root, ...env },
        stdio: "pipe",
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("CLI timed out"));
      }, 15000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input);
    });
  }
  cleanup.push(() => cli(["daemon", "stop"]));
  return {
    root,
    token,
    instanceToken,
    cloudUrl,
    cli,
    lists: () => lists,
    exchanges: () => exchanges,
    configs: () => configs,
  };
}

describe("standalone CLI daemon processes", () => {
  it("preserves structured stdout errors when device listing fails", async () => {
    const f = await fixture({ listFailure: true });
    await writePrivateJson(join(f.root, "caller.json"), { cloudUrl: f.cloudUrl, token: f.token });
    const result = await f.cli(["device"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "response",
      ok: false,
      error: { code: "gateway_unavailable" },
    });
  });
  it("authorizes a server from its environment, saves only the communication token, and reuses it", async () => {
    const f = await fixture();
    const args = ["auth", "--server", "--cloud", f.cloudUrl];
    const result = await f.cli(args, undefined, { ROME_INSTANCE_TOKEN: f.instanceToken });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ configured: true });
    expect(result.stdout + result.stderr).not.toContain(f.instanceToken);
    expect(result.stdout + result.stderr).not.toContain(f.token);
    const stored = await readFile(join(f.root, "caller.json"), "utf8");
    expect(JSON.parse(stored)).toEqual({ cloudUrl: f.cloudUrl, token: f.token });
    expect(stored).not.toContain(f.instanceToken);
    expect(JSON.parse((await f.cli(["daemon", "status"])).stdout)).toEqual({ running: false });
    const started = await f.cli(["daemon", "start"]);
    expect((await f.cli(args)).code).toBe(0);
    expect((await f.cli(["daemon", "status"])).stdout).toBe(started.stdout);
    expect(f.exchanges()).toBe(1);
    expect(f.configs()).toBe(1);
  });

  it("requires an instance token for initial server authorization", async () => {
    const f = await fixture();
    const result = await f.cli(["auth", "--server", "--cloud", f.cloudUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ROME_INSTANCE_TOKEN");
    expect(f.exchanges()).toBe(0);
  });

  it("retries temporary failures and retains the minted token across validation retries", async () => {
    const f = await fixture({ exchangeStatuses: [503, 200], validationFailures: 1 });
    const result = await f.cli(["auth", "--server", "--cloud", f.cloudUrl], undefined, {
      ROME_INSTANCE_TOKEN: f.instanceToken,
    });
    expect(result.code).toBe(0);
    expect(f.exchanges()).toBe(2);
    expect(f.configs()).toBe(2);
    expect(result.stderr).not.toContain(f.instanceToken);
  }, 20000);

  it("stops after three unsuccessful exchange attempts without saving credentials", async () => {
    const f = await fixture({ exchangeStatuses: [503, 429, 503] });
    const result = await f.cli(["auth", "--server", "--cloud", f.cloudUrl], undefined, {
      ROME_INSTANCE_TOKEN: f.instanceToken,
    });
    expect(result.code).toBe(1);
    expect(f.exchanges()).toBe(3);
    expect(JSON.parse((await f.cli(["auth", "status"])).stdout)).toEqual({ configured: false });
  }, 20000);

  it.each([
    401, 403, 404,
  ])("does not retry terminal exchange failures (%s) or print their bodies", async (status) => {
    const f = await fixture({ exchangeStatuses: [status] });
    const result = await f.cli(["auth", "--server", "--cloud", f.cloudUrl], undefined, {
      ROME_INSTANCE_TOKEN: f.instanceToken,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`HTTP ${status}`);
    expect(result.stderr).not.toContain(f.instanceToken);
    expect(f.exchanges()).toBe(1);
  });

  it("rejects an invalid credential response without saving or printing it", async () => {
    const f = await fixture({ issuedToken: "romeinst_secret_response" });
    const result = await f.cli(["auth", "--server", "--cloud", f.cloudUrl], undefined, {
      ROME_INSTANCE_TOKEN: f.instanceToken,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("romeinst_secret_response");
    expect(f.exchanges()).toBe(1);
    expect(f.configs()).toBe(0);
    expect(JSON.parse((await f.cli(["auth", "status"])).stdout)).toEqual({ configured: false });
  });

  it("preserves caller credentials for a different Cloud origin", async () => {
    const f = await fixture();
    const saved = { cloudUrl: "https://other.example", token: f.token };
    await writePrivateJson(join(f.root, "caller.json"), saved);
    const result = await f.cli(["auth", "--server", "--cloud", f.cloudUrl], undefined, {
      ROME_INSTANCE_TOKEN: f.instanceToken,
    });
    expect(result.code).toBe(1);
    expect(f.exchanges()).toBe(0);
    expect(JSON.parse(await readFile(join(f.root, "caller.json"), "utf8"))).toEqual(saved);
  });

  it("reports local auth without revealing tokens, contacting Cloud, or starting a daemon", async () => {
    const f = await fixture();
    expect(JSON.parse((await f.cli(["auth", "status"])).stdout)).toEqual({ configured: false });
    await writePrivateJson(join(f.root, "caller.json"), { cloudUrl: f.cloudUrl, token: f.token });
    const status = await f.cli(["auth", "status"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ configured: true, cloudUrl: f.cloudUrl });
    expect(status.stdout + status.stderr).not.toContain(f.token);
    expect(JSON.parse((await f.cli(["daemon", "status"])).stdout)).toEqual({ running: false });
    expect(f.lists()).toBe(0);
    await writePrivateJson(join(f.root, "caller.json"), { token: "invalid" });
    expect(JSON.parse((await f.cli(["auth", "status"])).stdout)).toEqual({ configured: false });
  });

  it("requires caller configuration without starting Rome Core", async () => {
    const f = await fixture();
    expect(JSON.parse((await f.cli(["daemon", "status"])).stdout)).toEqual({ running: false });
    const result = await f.cli(["device"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("rome-node auth");
  });

  it("authenticates once, shares a daemon across concurrent CLI calls, and recovers after stop or crash", async () => {
    const f = await fixture();
    const auth = await f.cli(["auth", "--cloud", f.cloudUrl], `${f.token}\n`);
    expect(auth.code).toBe(0);
    expect(auth.stdout).not.toContain(f.token);
    const results = await Promise.all(Array.from({ length: 10 }, () => f.cli(["device"])));
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ items: [{ id: "target" }] });
    }
    expect(f.lists()).toBe(10);
    const statuses = await Promise.all(Array.from({ length: 5 }, () => f.cli(["daemon", "start"])));
    const pids = statuses.map((result) => JSON.parse(result.stdout).pid);
    expect(new Set(pids).size).toBe(1);
    const changing = await f.cli(["auth", "--cloud", f.cloudUrl], f.token);
    expect(changing.code).toBe(1);
    expect(changing.stderr).toContain("Stop the CLI daemon");
    expect((await f.cli(["daemon", "stop"])).code).toBe(0);
    expect(JSON.parse((await f.cli(["daemon", "status"])).stdout)).toEqual({ running: false });
    const afterStop = await f.cli(["device"]);
    expect(afterStop.code, afterStop.stderr).toBe(0);
    const restarted = JSON.parse((await f.cli(["daemon", "status"])).stdout);
    expect(restarted.pid).not.toBe(pids[0]);
    process.kill(restarted.pid, "SIGKILL");
    const afterCrash = await f.cli(["device"]);
    expect(afterCrash.code, afterCrash.stderr).toBe(0);
    expect(JSON.parse((await f.cli(["daemon", "status"])).stdout).pid).not.toBe(restarted.pid);
  }, 30000);

  it("protects the daemon API and does not expose credentials in status", async () => {
    const f = await fixture();
    await writePrivateJson(join(f.root, "caller.json"), { cloudUrl: f.cloudUrl, token: f.token });
    const started = await f.cli(["daemon", "start"]);
    expect(started.code).toBe(0);
    const state = JSON.parse(await readFile(join(f.root, "daemon.json"), "utf8"));
    expect(started.stdout).not.toContain(state.token);
    for (const [path, method] of [
      ["/devices", "GET"],
      ["/run", "POST"],
      ["/stop", "POST"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${state.port}${path}`, { method });
      expect(response.status).toBe(401);
    }
    const retired = await fetch(`http://127.0.0.1:${state.port}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}` },
      body: "{}",
    });
    expect(retired.status).toBe(426);
    for (const headers of [
      {},
      { authorization: `Bearer ${state.token}`, origin: "https://example.com" },
    ]) {
      const rejected = new WebSocket(`ws://127.0.0.1:${state.port}/rpc`, { headers });
      const status = await new Promise<number>((resolve) => {
        rejected.on("error", () => {});
        rejected.on("unexpected-response", (_req, response) => {
          resolve(response.statusCode!);
          rejected.terminate();
        });
      });
      expect(status).toBe(401);
    }
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}/rpc`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    cleanup.push(async () => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const exchange = (request: unknown) =>
      new Promise<unknown>((resolve) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString())));
        socket.send(typeof request === "string" ? request : JSON.stringify(request));
      });
    const request = (method: string, params = {}) =>
      exchange({ jsonrpc: "2.0", id: "test", method, params });
    expect(await request("daemon.status")).toMatchObject({ error: { code: -32001 } });
    expect(await request("daemon.hello", { protocolVersion: 1 })).toMatchObject({
      error: { code: -32002 },
    });
    expect(await request("daemon.hello", { protocolVersion: 2 })).toEqual({
      jsonrpc: "2.0",
      id: "test",
      result: { pid: state.pid, protocolVersion: 2, connection: "stopped" },
    });
    expect(await request("devices.run")).toMatchObject({ error: { code: -32602 } });
    expect(await request("events.subscribe", { topic: "unknown" })).toMatchObject({
      error: { code: -32602 },
    });
    expect(await request("missing")).toMatchObject({ error: { code: -32601 } });
    expect(await exchange("{")).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await exchange([])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(
      await exchange([
        { jsonrpc: "2.0", method: "daemon.status" },
        { jsonrpc: "2.0", id: 7, method: "daemon.status" },
        { jsonrpc: "2.0", id: 8, method: "missing" },
      ]),
    ).toMatchObject([
      { id: 7, result: { pid: state.pid } },
      { id: 8, error: { code: -32601 } },
    ]);
    expect(f.lists()).toBe(0);
  });
});
