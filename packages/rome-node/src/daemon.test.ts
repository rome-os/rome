import { afterEach, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writePrivateJson } from "./storage.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rome-node-daemon-"));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const token = `romedev_${"a".repeat(43)}`;
  let lists = 0;
  const cloud = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: "invalid_device_session" }));
    } else if (req.url === "/v1/gateway/config") {
      res.end(JSON.stringify({ gatewayUrl: "wss://gateway.example/connect" }));
    } else if (req.url === "/api/account/devices") {
      lists++;
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
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path, ...args], {
        env: { ...process.env, ROME_NODE_CONFIG_DIR: root },
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
  return { root, token, cloudUrl, cli, lists: () => lists };
}

describe("standalone CLI daemon processes", () => {
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
      expect(result.code).toBe(0);
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
    expect((await f.cli(["device"])).code).toBe(0);
    const restarted = JSON.parse((await f.cli(["daemon", "status"])).stdout);
    expect(restarted.pid).not.toBe(pids[0]);
    process.kill(restarted.pid, "SIGKILL");
    const afterCrash = await f.cli(["device"]);
    expect(afterCrash.code).toBe(0);
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
    const invalid = await fetch(`http://127.0.0.1:${state.port}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}` },
      body: "{}",
    });
    expect(invalid.status).toBe(400);
    const oversized = await fetch(`http://127.0.0.1:${state.port}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}` },
      body: "x".repeat(128 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(f.lists()).toBe(0);
  });
});
