import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { startSigner } from "./signer.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const T0 = 1_700_000_000_000;

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  const clock = { now: T0 };
  const lines: string[] = [];
  const options = {
    audience: "https://cloud.example",
    keyDir: join(dir, "keys"),
    socketPath: join(dir, "signer.sock"),
    now: () => clock.now,
    log: (line: string) => lines.push(line),
  };
  const signer = await startSigner(options);
  cleanups.push(() => {
    signer.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...options, clock, lines };
}

interface ListedSecret {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  grantedUntil?: string;
}
type Reply = { status: number; body: { secrets: ListedSecret[] } & Record<string, unknown> };

function call(socketPath: string, method: string, path: string, body?: unknown | string) {
  return new Promise<Reply>((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    );
  });
}

const put = (s: { socketPath: string }, name: string, value: string, description?: string) =>
  call(s.socketPath, "PUT", `/v1/secrets/${name}`, { value, description });
const grant = (s: { socketPath: string }, name: string, ttlSeconds: number) =>
  call(s.socketPath, "POST", "/v1/grants", { name, ttlSeconds });
const release = (s: { socketPath: string }, name: string) =>
  call(s.socketPath, "POST", `/v1/secrets/${name}/release`);

describe("vault store", () => {
  it("lists metadata only, never values", async () => {
    const s = await start();
    expect((await put(s, "GITHUB_TOKEN", "ghp_secret_value", "CI token")).status).toBe(200);
    const list = await call(s.socketPath, "GET", "/v1/secrets");
    expect(list.status).toBe(200);
    expect(list.body.secrets).toEqual([
      {
        name: "GITHUB_TOKEN",
        description: "CI token",
        createdAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
        lastUsedAt: null,
      },
    ]);
    expect(JSON.stringify(list.body)).not.toContain("ghp_secret_value");
  });

  it("writes secrets.json with mode 0600 through a temp file that is renamed away", async () => {
    const s = await start();
    await put(s, "A_KEY", "one");
    await put(s, "B_KEY", "two");
    expect(statSync(join(s.keyDir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(s.keyDir).filter((file) => file.includes("tmp"))).toEqual([]);
    const stored = JSON.parse(readFileSync(join(s.keyDir, "secrets.json"), "utf8"));
    expect(Object.keys(stored)).toEqual(["A_KEY", "B_KEY"]);
    expect(Object.keys(stored.A_KEY).sort()).toEqual([
      "createdAt",
      "description",
      "lastUsedAt",
      "updatedAt",
      "value",
    ]);
  });

  it("keeps secrets across a restart but drops grants", async () => {
    const s = await start();
    await put(s, "A_KEY", "one");
    await grant(s, "A_KEY", 60);
    const second = await startSigner({
      audience: s.audience,
      keyDir: s.keyDir,
      socketPath: `${s.socketPath}2`,
      now: s.now,
      log: () => {},
    });
    cleanups.push(() => second.server.close());
    const list = await call(`${s.socketPath}2`, "GET", "/v1/secrets");
    expect(list.body.secrets.map((secret) => secret.name)).toEqual(["A_KEY"]);
    expect(list.body.secrets[0].grantedUntil).toBeUndefined();
    expect((await release({ socketPath: `${s.socketPath}2` }, "A_KEY")).status).toBe(403);
  });

  it("replaces a value, keeping createdAt and the old description when none is sent", async () => {
    const s = await start();
    await put(s, "A_KEY", "one", "first");
    s.clock.now += 5000;
    await put(s, "A_KEY", "two");
    const [entry] = (await call(s.socketPath, "GET", "/v1/secrets")).body.secrets;
    expect(entry.description).toBe("first");
    expect(entry.createdAt).toBe(new Date(T0).toISOString());
    expect(entry.updatedAt).toBe(new Date(T0 + 5000).toISOString());
  });

  it.each([
    "lower",
    "1ABC",
    "HAS-DASH",
    "A".repeat(65),
    "HAS SPACE",
  ])("rejects the name %j", async (name) => {
    const s = await start();
    expect((await put(s, encodeURIComponent(name), "v")).status).toBe(400);
  });

  it.each([
    ["empty", ""],
    ["too long", "x".repeat(32769)],
  ])("rejects a %s value", async (_label, value) => {
    const s = await start();
    expect((await put(s, "A_KEY", value)).status).toBe(400);
  });

  it("rejects bad bodies and caps the body size", async () => {
    const s = await start();
    expect((await call(s.socketPath, "PUT", "/v1/secrets/A_KEY", "not json")).status).toBe(400);
    expect((await call(s.socketPath, "PUT", "/v1/secrets/A_KEY", { value: 5 })).status).toBe(400);
    expect((await put(s, "A_KEY", "v", "d".repeat(201))).status).toBe(400);
    const huge = await call(s.socketPath, "PUT", "/v1/secrets/A_KEY", {
      value: "x".repeat(300 * 1024),
    }).catch(() => ({ status: 0 }));
    expect([0, 400]).toContain(huge.status);
    expect((await call(s.socketPath, "GET", "/v1/secrets")).body.secrets).toEqual([]);
  });
});

describe("vault grants and release", () => {
  it("refuses release without a grant, and for unknown names", async () => {
    const s = await start();
    await put(s, "A_KEY", "one");
    expect(await release(s, "A_KEY")).toEqual({ status: 403, body: { error: "no_grant" } });
    expect((await release(s, "MISSING")).status).toBe(404);
  });

  it("releases the value inside the grant window and stops at expiry", async () => {
    const s = await start();
    await put(s, "A_KEY", "one");
    const granted = await grant(s, "A_KEY", 900);
    expect(granted).toEqual({
      status: 200,
      body: { name: "A_KEY", expiresAt: new Date(T0 + 900_000).toISOString() },
    });
    s.clock.now += 899_000;
    const live = await release(s, "A_KEY");
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ value: "one", expiresAt: new Date(T0 + 900_000).toISOString() });
    expect((await call(s.socketPath, "GET", "/v1/secrets")).body.secrets[0]).toMatchObject({
      lastUsedAt: new Date(T0 + 899_000).toISOString(),
      grantedUntil: new Date(T0 + 900_000).toISOString(),
    });
    // A grant allows repeated releases until it expires.
    expect((await release(s, "A_KEY")).status).toBe(200);
    s.clock.now += 1000;
    expect((await release(s, "A_KEY")).status).toBe(403);
    expect(
      (await call(s.socketPath, "GET", "/v1/secrets")).body.secrets[0].grantedUntil,
    ).toBeUndefined();
  });

  it("validates grant requests", async () => {
    const s = await start();
    await put(s, "A_KEY", "one");
    expect((await grant(s, "MISSING", 60)).status).toBe(404);
    for (const ttl of [0, -1, 1.5, 10801]) expect((await grant(s, "A_KEY", ttl)).status).toBe(400);
    expect((await grant(s, "A_KEY", 10800)).status).toBe(200);
    expect((await call(s.socketPath, "POST", "/v1/grants", { name: "A_KEY" })).status).toBe(400);
  });

  it("scopes grants to one name", async () => {
    const s = await start();
    await put(s, "A_KEY", "one");
    await put(s, "B_KEY", "two");
    await grant(s, "A_KEY", 60);
    expect((await release(s, "A_KEY")).status).toBe(200);
    expect((await release(s, "B_KEY")).status).toBe(403);
  });

  it("drops the grant when the secret is deleted", async () => {
    const s = await start();
    await put(s, "A_KEY", "one");
    await grant(s, "A_KEY", 60);
    expect((await call(s.socketPath, "DELETE", "/v1/secrets/A_KEY")).status).toBe(200);
    expect((await call(s.socketPath, "DELETE", "/v1/secrets/A_KEY")).status).toBe(404);
    await put(s, "A_KEY", "again");
    expect((await release(s, "A_KEY")).status).toBe(403);
    expect(JSON.parse(readFileSync(join(s.keyDir, "secrets.json"), "utf8")).A_KEY.value).toBe(
      "again",
    );
  });
});

describe("vault logging and token routes", () => {
  it("logs one JSON line per action with the name and outcome, never a value", async () => {
    const s = await start();
    await put(s, "A_KEY", "super-secret-value", "super-secret-description");
    await grant(s, "A_KEY", 60);
    await release(s, "A_KEY");
    await call(s.socketPath, "DELETE", "/v1/secrets/A_KEY");
    const entries = s.lines.map((line) => JSON.parse(line));
    expect(entries.map((e) => [e.event, e.name, e.outcome])).toEqual([
      ["vault_put", "A_KEY", "created"],
      ["vault_grant", "A_KEY", "granted"],
      ["vault_release", "A_KEY", "released"],
      ["vault_delete", "A_KEY", "deleted"],
    ]);
    expect(s.lines.join("\n")).not.toContain("super-secret");
  });

  it("leaves the token endpoint working next to the vault", async () => {
    const s = await start();
    expect((await call(s.socketPath, "POST", "/v1/token")).status).toBe(200);
    expect((await call(s.socketPath, "GET", "/v1/nope")).status).toBe(404);
  });
});
