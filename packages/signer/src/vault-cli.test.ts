import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { startSigner } from "./signer.js";
import { runVault } from "./vault-cli.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const PIN = "123456";

/** A signer whose vault already has a PIN. */
async function startVault() {
  const dir = mkdtempSync(join(tmpdir(), "vault-cli-"));
  const socketPath = join(dir, "signer.sock");
  const { server } = await startSigner({
    audience: "https://cloud.example",
    keyDir: join(dir, "keys"),
    socketPath,
    log: () => {},
  });
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await signer(socketPath, "POST", "/v1/pin", { pin: PIN });
  return socketPath;
}

function signer(socketPath: string, method: string, path: string, body?: unknown) {
  return new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function run(argv: string[], env: NodeJS.ProcessEnv) {
  let out = "";
  let err = "";
  const code = await runVault(argv, env, {
    out: (bytes) => (out += bytes.toString()),
    err: (bytes) => (err += bytes.toString()),
  });
  return { code, out, err };
}

const node = (script: string) => ["--", process.execPath, "-e", script];

describe("vault search", () => {
  it("lists metadata and filters by query, without values", async () => {
    const socketPath = await startVault();
    await signer(socketPath, "PUT", "/v1/secrets/GITHUB_TOKEN", {
      value: "ghp_topsecret",
      description: "CI token",
      pin: PIN,
    });
    await signer(socketPath, "PUT", "/v1/secrets/STRIPE_KEY", { value: "sk_live_x", pin: PIN });
    await signer(socketPath, "POST", "/v1/grants", {
      name: "GITHUB_TOKEN",
      ttlSeconds: 60,
      pin: PIN,
    });
    const env = { ROME_SIGNER_SOCKET: socketPath };

    const all = await run(["search"], env);
    expect(all.code).toBe(0);
    expect(all.out).toContain("GITHUB_TOKEN");
    expect(all.out).toContain("CI token");
    expect(all.out).toContain("STRIPE_KEY");
    expect(all.out).not.toContain("topsecret");

    const some = await run(["search", "stripe"], env);
    expect(some.out).toContain("STRIPE_KEY");
    expect(some.out).not.toContain("GITHUB_TOKEN");
    expect((await run(["search", "nothing"], env)).out).toBe("No secrets found.\n");
  });
});

describe("vault load", () => {
  it("runs the command with the secrets in its env and masks its output", async () => {
    const socketPath = await startVault();
    for (const [name, value] of [
      ["FIRST_KEY", "value-one-1234"],
      ["SECOND_KEY", "value-two-5678"],
    ]) {
      await signer(socketPath, "PUT", `/v1/secrets/${name}`, { value, pin: PIN });
      await signer(socketPath, "POST", "/v1/grants", { name, ttlSeconds: 60, pin: PIN });
    }
    const script =
      "console.log(process.env.FIRST_KEY, process.env.SECOND_KEY);" +
      "console.error('err:' + process.env.SECOND_KEY);" +
      "process.exit(3)";
    const result = await run(["load", "FIRST_KEY,SECOND_KEY", ...node(script)], {
      ROME_SIGNER_SOCKET: socketPath,
    });
    expect(result.code).toBe(3);
    expect(result.out).toBe("[vault:FIRST_KEY] [vault:SECOND_KEY]\n");
    expect(result.err).toBe("err:[vault:SECOND_KEY]\n");
  });

  it("tells the agent to ask for a grant when there is none", async () => {
    const socketPath = await startVault();
    await signer(socketPath, "PUT", "/v1/secrets/FIRST_KEY", { value: "v", pin: PIN });
    const result = await run(["load", "FIRST_KEY", ...node("console.log('ran')")], {
      ROME_SIGNER_SOCKET: socketPath,
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain(
      "No grant for FIRST_KEY. Ask the guardian with the vault_apply action first.",
    );
  });

  it("explains when the instance has no signer", async () => {
    const result = await run(["load", "FIRST_KEY", ...node("1")], {
      ROME_SIGNER_SOCKET: "/nonexistent/signer.sock",
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe("vault: The vault is not available on this instance (no signer).\n");
  });

  it("shows no secret when a released value cannot go in an environment", async () => {
    // A stub signer releases a value with a NUL, which the signer itself now refuses to store.
    const dir = mkdtempSync(join(tmpdir(), "vault-cli-stub-"));
    const socketPath = join(dir, "signer.sock");
    const stub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ value: "topsecret\u0000value", expiresAt: "2099-01-01T00:00:00.000Z" }),
      );
    });
    await new Promise<void>((resolve) => stub.listen(socketPath, resolve));
    cleanups.push(() => {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const result = await run(["load", "FIRST_KEY", ...node("console.log('ran')")], {
      ROME_SIGNER_SOCKET: socketPath,
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toBe(`vault: cannot run ${process.execPath}: invalid environment\n`);
    expect(`${result.out}${result.err}`).not.toContain("topsecret");
  });

  it("rejects bad usage", async () => {
    for (const argv of [
      ["load"],
      ["load", "A_KEY"],
      ["load", "a_key", "--", "true"],
      ["load", "A_KEY", "--"],
    ]) {
      expect((await run(argv, {})).code).toBe(2);
    }
  });
});

describe("vault help", () => {
  it("prints usage without needing a signer", async () => {
    const result = await run(["help"], {});
    expect(result.code).toBe(0);
    expect(result.out).toContain("vault load NAME");
  });
});
