import { afterEach, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for CLI");
    await delay(10);
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(options: { pollError?: string; transientStatus?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rome-node-connect-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const token = `romedev_${"a".repeat(43)}`;
  const deviceCode = "secret-device-code";
  let socket: WebSocket | undefined;
  let gatewayAuthorization: string | undefined;
  const gateway = createServer();
  const sockets = new WebSocketServer({ server: gateway });
  const gatewayUrl = (await listen(gateway)).replace("http:", "ws:");
  cleanup.push(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  sockets.on("connection", (client, request) => {
    gatewayAuthorization = request.headers.authorization;
    socket = client;
  });
  const requests: { path: string; form: Record<string, string>; contentType?: string }[] = [];
  let transientStatus = options.transientStatus;
  let cloudUrl = "";
  const cloud = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    const form = Object.fromEntries(new URLSearchParams(body));
    requests.push({ path: req.url!, form, contentType: req.headers["content-type"] });
    res.setHeader("content-type", "application/json");
    if (req.url === "/oauth2/device_authorization") {
      res.end(
        JSON.stringify({
          device_code: deviceCode,
          user_code: "ABCD-1234",
          verification_uri: `${cloudUrl}/device`,
          verification_uri_complete: `${cloudUrl}/device?user_code=ABCD-1234`,
          expires_in: 60,
          interval: 1,
        }),
      );
    } else if (req.url === "/oauth2/token") {
      if (transientStatus) {
        res
          .writeHead(transientStatus, { "content-type": "text/html" })
          .end("<html>Try later</html>");
        transientStatus = undefined;
      } else if (options.pollError)
        res
          .writeHead(400)
          .end(JSON.stringify({ error: options.pollError, error_description: token }));
      else
        res.end(JSON.stringify({ access_token: token, token_type: "Bearer", device_id: "target" }));
    } else if (req.headers.authorization !== `Bearer ${token}`) res.writeHead(401).end("{}");
    else if (req.url === "/v1/gateway/config") res.end(JSON.stringify({ gatewayUrl }));
    else if (req.url === "/api/account/devices") res.end(JSON.stringify({ items: [] }));
    else res.writeHead(404).end("{}");
  });
  cloudUrl = await listen(cloud);

  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, [resolve("bin/rome-node.js"), ...args], {
      env: { ...process.env, ROME_NODE_CONFIG_DIR: root, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    return { child, exited, output: () => output };
  }
  return {
    root,
    token,
    deviceCode,
    cloudUrl,
    requests,
    run,
    socket: () => socket,
    gatewayAuthorization: () => gatewayAuthorization,
  };
}

describe("connect authorization modes", () => {
  it("authorizes with a device code, runs system.info, reuses credentials, and stops on revocation", async () => {
    const f = await fixture();
    const args = ["connect", "--device-code", "--name", "Remote Linux", "--cloud", f.cloudUrl];
    const first = f.run(args);
    await until(() => first.output().includes("Connection: online"));
    expect(first.output()).toContain(`${f.cloudUrl}/device\n`);
    expect(first.output()).toContain("User code: ABCD-1234");
    expect(first.output()).toContain(`${f.cloudUrl}/device?user_code=ABCD-1234`);
    expect(first.output()).toContain("Expires in 60 seconds");
    expect(first.output()).not.toContain("redirect_uri");
    expect(first.output()).not.toContain(f.deviceCode);
    expect(first.output()).not.toContain(f.token);
    expect(f.requests[0]).toMatchObject({
      path: "/oauth2/device_authorization",
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      form: {
        client_id: "rome-computer",
        display_name: "Remote Linux",
        platform: platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux",
      },
    });
    expect(f.requests[1].form).toEqual({
      client_id: "rome-computer",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: f.deviceCode,
    });
    expect(f.gatewayAuthorization()).toBe(`Bearer ${f.token}`);
    const reply = new Promise<unknown>((resolve) =>
      f.socket()!.once("message", (data) => resolve(JSON.parse(data.toString()))),
    );
    f.socket()!.send(
      JSON.stringify({
        id: "info",
        from: "caller",
        payload: { type: "request", action: "system.info", args: {} },
      }),
    );
    expect(await reply).toMatchObject({
      id: "info",
      to: "caller",
      payload: { ok: true, result: { name: "Remote Linux", actions: ["system.info", "exec"] } },
    });
    expect(JSON.parse(await readFile(join(f.root, "credential.json"), "utf8"))).toEqual({
      cloudUrl: f.cloudUrl,
      token: f.token,
      deviceId: "target",
      name: "Remote Linux",
    });
    f.socket()!.close(4002);
    expect(await first.exited).toBe(1);

    const second = f.run(args);
    await until(() => second.output().includes("Connection: online"));
    expect(f.requests.filter((r) => r.path === "/oauth2/device_authorization")).toHaveLength(1);
    expect(second.output()).not.toContain("User code:");
    f.socket()!.close(4001);
    expect(await second.exited).toBe(1);
    expect(second.output()).toContain("Authorization revoked");
    expect(second.output()).not.toContain(f.token);
    await delay(100);
    expect(f.socket()?.readyState).toBe(3);
  }, 10000);

  it("exits on denial without storing or revealing credentials", async () => {
    const f = await fixture({ pollError: "access_denied" });
    const child = f.run(["connect", "--device-code", "--cloud", f.cloudUrl]);
    expect(await child.exited).toBe(1);
    expect(child.output()).toContain("denied");
    expect(child.output()).not.toContain(f.deviceCode);
    expect(child.output()).not.toContain(f.token);
    expect(f.requests[0].form.display_name).toBe(
      hostname()
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 80) || "Computer",
    );
    await expect(readFile(join(f.root, "credential.json"))).rejects.toThrow();
    expect(f.socket()).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "cancels on Ctrl+C while waiting for approval",
    async () => {
      const f = await fixture({ pollError: "authorization_pending" });
      const child = f.run(["connect", "--device-code", "--cloud", f.cloudUrl]);
      await until(() => child.output().includes("Waiting for approval"));
      child.child.kill("SIGINT");
      expect(await child.exited).toBe(0);
      expect(f.requests).toHaveLength(1);
      await expect(readFile(join(f.root, "credential.json"))).rejects.toThrow();
    },
  );

  it("keeps the default loopback flow even in an SSH environment", async () => {
    const f = await fixture();
    const child = f.run(["connect", "--cloud", f.cloudUrl], { SSH_CONNECTION: "test" });
    await until(() => child.output().includes("/oauth2/authorize?"));
    const url = new URL(
      child
        .output()
        .split("\n")
        .find((line) => line.startsWith(`${f.cloudUrl}/oauth2/authorize?`))!,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      code: "approved",
      state: url.searchParams.get("state")!,
      iss: f.cloudUrl,
    }).toString();
    expect((await fetch(callback)).status).toBe(200);
    await until(() => child.output().includes("Connection: online"));
    expect(f.requests.some((r) => r.path === "/oauth2/device_authorization")).toBe(false);
    expect(f.requests[0].form.grant_type).toBe("authorization_code");
    f.socket()!.close(4001);
    await child.exited;
  });

  it.each([429, 503])("recovers from HTTP %s during device-code polling", async (status) => {
    const f = await fixture({ transientStatus: status });
    const child = f.run(["connect", "--device-code", "--cloud", f.cloudUrl]);
    await until(() => child.output().includes("Connection: online"));
    expect(f.requests.filter((r) => r.path === "/oauth2/device_authorization")).toHaveLength(1);
    expect(f.requests.filter((r) => r.path === "/oauth2/token")).toHaveLength(2);
    expect(child.output().match(/User code:/g)).toHaveLength(1);
    expect(child.output()).not.toContain("rejected");
    expect(child.output()).not.toContain(f.deviceCode);
    expect(child.output()).not.toContain(f.token);
    f.socket()!.close(4001);
    expect(await child.exited).toBe(1);
  }, 10000);

  it("documents the flag offline and rejects it on other commands", async () => {
    const f = await fixture();
    const help = f.run(["help", "connect"]);
    expect(await help.exited).toBe(0);
    expect(help.output()).toContain("--device-code");
    for (const args of [["auth"], ["device"], ["daemon", "status"], ["watch"]]) {
      const child = f.run([...args, "--device-code"]);
      expect(await child.exited).toBe(1);
      expect(child.output()).toContain("--device-code is only supported by rome-node connect");
    }
    expect(f.requests).toHaveLength(0);
  });
});
