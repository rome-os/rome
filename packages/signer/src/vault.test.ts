import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const PIN = "123456";
const WRONG = "000000";
const LOCK_MS = 15 * 60 * 1000;

/** Starts a signer on a temporary key directory, with the PIN already set unless `pin` is false. */
async function start({ pin = true }: { pin?: boolean } = {}) {
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
  if (pin) await call(options.socketPath, "POST", "/v1/pin", { pin: PIN });
  return { ...options, clock, lines };
}

/** A second signer on the same key directory, as after a restart. */
async function restart(s: Awaited<ReturnType<typeof start>>) {
  const second = await startSigner({ ...s, socketPath: `${s.socketPath}2`, log: () => {} });
  cleanups.push(() => second.server.close());
  return { ...s, socketPath: `${s.socketPath}2` };
}

interface ListedSecret {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  grantedUntil?: string;
}
type Reply = {
  status: number;
  body: {
    secrets: ListedSecret[];
    pin: { set: boolean; lockedUntil: string | null };
  } & Record<string, unknown>;
};

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

const put = (
  s: { socketPath: string },
  name: string,
  value: string,
  description?: string,
  pin: unknown = PIN,
) => call(s.socketPath, "PUT", `/v1/secrets/${name}`, { value, description, pin });
const grant = (s: { socketPath: string }, name: string, ttlSeconds: number, pin: unknown = PIN) =>
  call(s.socketPath, "POST", "/v1/grants", { name, ttlSeconds, pin });
const grantMany = (s: { socketPath: string }, names: unknown, ttlSeconds: number, pin = PIN) =>
  call(s.socketPath, "POST", "/v1/grants", { names, ttlSeconds, pin });
const reset = (s: { socketPath: string }, pin: unknown = PIN) =>
  call(s.socketPath, "POST", "/v1/reset", { pin });
const pinFile = (s: { keyDir: string }) =>
  JSON.parse(readFileSync(join(s.keyDir, "vault-pin.json"), "utf8"));
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
    expect(list.body.pin).toEqual({ set: true, lockedUntil: null });
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
    const second = await restart(s);
    const list = await call(second.socketPath, "GET", "/v1/secrets");
    expect(list.body.secrets.map((secret) => secret.name)).toEqual(["A_KEY"]);
    expect(list.body.secrets[0].grantedUntil).toBeUndefined();
    expect((await release(second, "A_KEY")).status).toBe(403);
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

  it("rejects a value with a NUL character, and stores nothing", async () => {
    const s = await start();
    expect((await put(s, "A_KEY", "secret\u0000value")).status).toBe(400);
    expect((await call(s.socketPath, "GET", "/v1/secrets")).body.secrets).toEqual([]);
  });

  it("rejects bad bodies and caps the body size", async () => {
    const s = await start();
    expect((await call(s.socketPath, "PUT", "/v1/secrets/A_KEY", "not json")).status).toBe(400);
    expect(
      (await call(s.socketPath, "PUT", "/v1/secrets/A_KEY", { value: 5, pin: PIN })).status,
    ).toBe(400);
    expect((await put(s, "A_KEY", "v", "d".repeat(201))).status).toBe(400);
    const huge = await call(s.socketPath, "PUT", "/v1/secrets/A_KEY", {
      value: "x".repeat(300 * 1024),
      pin: PIN,
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
    expect(
      (await call(s.socketPath, "POST", "/v1/grants", { name: "A_KEY", pin: PIN })).status,
    ).toBe(400);
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

describe("vault PIN", () => {
  it("sets the PIN once, stores only a salted hash, and reports it in the list", async () => {
    const s = await start({ pin: false });
    expect((await call(s.socketPath, "GET", "/v1/secrets")).body.pin).toEqual({
      set: false,
      lockedUntil: null,
    });
    expect(await call(s.socketPath, "POST", "/v1/pin", { pin: PIN })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await call(s.socketPath, "POST", "/v1/pin", { pin: "654321" })).toEqual({
      status: 409,
      body: { error: "pin_already_set" },
    });
    expect((await call(s.socketPath, "GET", "/v1/secrets")).body.pin).toEqual({
      set: true,
      lockedUntil: null,
    });
    const file = join(s.keyDir, "vault-pin.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(pinFile(s)).sort()).toEqual(["failures", "hash", "lockedUntil", "salt"]);
    expect(readFileSync(file, "utf8")).not.toContain(PIN);
    expect(readdirSync(s.keyDir).filter((name) => name.includes("tmp"))).toEqual([]);
    // The second PIN did not replace the first.
    expect((await put(s, "A_KEY", "v")).status).toBe(200);
  });

  it.each([
    ["too short", "12345"],
    ["too long", "1234567"],
    ["letters", "12345a"],
    ["a number", 123456],
    ["null", null],
  ])("refuses a %s PIN as invalid, without counting it", async (_label, bad) => {
    const s = await start();
    expect((await put(s, "A_KEY", "v", undefined, bad)).body).toEqual({ error: "invalid_pin" });
    expect((await grant(s, "A_KEY", 60, bad)).status).toBe(404);
    await put(s, "A_KEY", "v");
    expect((await grant(s, "A_KEY", 60, bad)).body).toEqual({ error: "invalid_pin" });
    expect((await call(s.socketPath, "POST", "/v1/pin", { pin: bad })).status).toBe(400);
    expect((await reset(s, bad)).status).toBe(400);
    expect(pinFile(s).failures).toBe(0);
    expect((await grant(s, "A_KEY", 60, WRONG)).body).toEqual({
      error: "wrong_pin",
      attemptsLeft: 2,
    });
  });

  it("refuses a write and a grant while no PIN is set", async () => {
    const s = await start({ pin: false });
    expect(await put(s, "A_KEY", "v")).toEqual({ status: 409, body: { error: "pin_not_set" } });
    expect((await call(s.socketPath, "GET", "/v1/secrets")).body.secrets).toEqual([]);
    // A secret that exists without a PIN cannot be granted either.
    writeFileSync(
      join(s.keyDir, "secrets.json"),
      JSON.stringify({
        A_KEY: { value: "v", description: "", createdAt: "x", updatedAt: "x", lastUsedAt: null },
      }),
    );
    const second = await restart(s);
    expect(await grant(second, "A_KEY", 60)).toEqual({
      status: 409,
      body: { error: "pin_not_set" },
    });
    expect((await release(second, "A_KEY")).status).toBe(403);
  });

  it("checks the name, value and ttl before the PIN, so a malformed request costs no attempt", async () => {
    const s = await start();
    expect((await put(s, "A_KEY", "", undefined, WRONG)).status).toBe(400);
    expect((await put(s, "A_KEY", "v", "d".repeat(201), WRONG)).status).toBe(400);
    expect((await grant(s, "MISSING", 60, WRONG)).status).toBe(404);
    await put(s, "A_KEY", "v");
    expect((await grant(s, "A_KEY", 0, WRONG)).status).toBe(400);
    expect(pinFile(s).failures).toBe(0);
  });

  it("counts wrong PINs, locks at the third, and resets the count on a right one", async () => {
    const s = await start();
    await put(s, "A_KEY", "v");
    expect(await put(s, "A_KEY", "w", undefined, WRONG)).toEqual({
      status: 403,
      body: { error: "wrong_pin", attemptsLeft: 2 },
    });
    expect(pinFile(s).failures).toBe(1);
    expect((await grant(s, "A_KEY", 60, PIN)).status).toBe(200);
    expect(pinFile(s).failures).toBe(0);
    expect((await grant(s, "A_KEY", 60, WRONG)).body).toMatchObject({ attemptsLeft: 2 });
    expect((await grant(s, "A_KEY", 60, WRONG)).body).toMatchObject({ attemptsLeft: 1 });
    expect(await grant(s, "A_KEY", 60, WRONG)).toEqual({
      status: 423,
      body: { error: "locked", lockedUntil: new Date(T0 + LOCK_MS).toISOString() },
    });
    // The lock is on disk before the reply.
    expect(pinFile(s)).toMatchObject({ failures: 0, lockedUntil: T0 + LOCK_MS });
    expect((await call(s.socketPath, "GET", "/v1/secrets")).body.pin).toEqual({
      set: true,
      lockedUntil: new Date(T0 + LOCK_MS).toISOString(),
    });
  });

  it("refuses everything while locked, even the right PIN, without counting", async () => {
    const s = await start();
    await put(s, "A_KEY", "v");
    for (let i = 0; i < 3; i++) await grant(s, "A_KEY", 60, WRONG);
    const before = readFileSync(join(s.keyDir, "vault-pin.json"), "utf8");
    s.clock.now += 60_000;
    for (const pin of [PIN, WRONG]) {
      expect((await grant(s, "A_KEY", 60, pin)).body).toEqual({
        error: "locked",
        lockedUntil: new Date(T0 + LOCK_MS).toISOString(),
      });
      expect((await put(s, "A_KEY", "w", undefined, pin)).status).toBe(423);
    }
    expect(readFileSync(join(s.keyDir, "vault-pin.json"), "utf8")).toBe(before);
    expect((await release(s, "A_KEY")).status).toBe(403);
  });

  it("keeps the lock across a restart", async () => {
    const s = await start();
    for (let i = 0; i < 3; i++) await put(s, "A_KEY", "v", undefined, WRONG);
    const second = await restart(s);
    expect((await put(second, "A_KEY", "v")).status).toBe(423);
    expect((await call(second.socketPath, "GET", "/v1/secrets")).body.pin).toEqual({
      set: true,
      lockedUntil: new Date(T0 + LOCK_MS).toISOString(),
    });
  });

  it("keeps a partial count across a restart", async () => {
    const s = await start();
    await put(s, "A_KEY", "v", undefined, WRONG);
    const second = await restart(s);
    expect((await put(second, "A_KEY", "v", undefined, WRONG)).body).toMatchObject({
      attemptsLeft: 1,
    });
  });

  it("unlocks when the time has passed, with three fresh attempts", async () => {
    const s = await start();
    for (let i = 0; i < 3; i++) await put(s, "A_KEY", "v", undefined, WRONG);
    s.clock.now += LOCK_MS - 1;
    expect((await put(s, "A_KEY", "v")).status).toBe(423);
    s.clock.now += 1;
    expect((await call(s.socketPath, "GET", "/v1/secrets")).body.pin.lockedUntil).toBeNull();
    expect((await put(s, "A_KEY", "v", undefined, WRONG)).body).toMatchObject({ attemptsLeft: 2 });
    expect((await put(s, "A_KEY", "v")).status).toBe(200);
  });

  it("lets at most three of five parallel wrong guesses reach the check", async () => {
    const s = await start();
    await put(s, "A_KEY", "v");
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => grant(s, "A_KEY", 60, WRONG)),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([403, 403, 423, 423, 423]);
    // A right guess in the same burst gets no grant either.
    const mixed = await Promise.all([grant(s, "A_KEY", 60, PIN), grant(s, "A_KEY", 60, WRONG)]);
    expect(mixed.map((reply) => reply.status)).toEqual([423, 423]);
    expect((await release(s, "A_KEY")).status).toBe(403);
  });

  it("resets the vault: no secrets, no grants, a new PIN, and it works while locked", async () => {
    const s = await start();
    await put(s, "A_KEY", "one");
    await grant(s, "A_KEY", 60);
    for (let i = 0; i < 3; i++) await put(s, "A_KEY", "v", undefined, WRONG);
    expect((await put(s, "A_KEY", "v")).status).toBe(423);

    expect(await reset(s, "654321")).toEqual({ status: 200, body: { ok: true } });
    expect(JSON.parse(readFileSync(join(s.keyDir, "secrets.json"), "utf8"))).toEqual({});
    const list = await call(s.socketPath, "GET", "/v1/secrets");
    expect(list.body).toEqual({ secrets: [], pin: { set: true, lockedUntil: null } });
    expect(pinFile(s)).toMatchObject({ failures: 0, lockedUntil: null });
    expect((await put(s, "A_KEY", "two", undefined, PIN)).body).toMatchObject({
      error: "wrong_pin",
    });
    expect((await put(s, "A_KEY", "two", undefined, "654321")).status).toBe(200);
    // The grant of the old secret did not survive the reset.
    expect((await release(s, "A_KEY")).status).toBe(403);
  });

  it("resets a vault that has no PIN yet", async () => {
    const s = await start({ pin: false });
    expect((await reset(s)).status).toBe(200);
    expect((await put(s, "A_KEY", "v")).status).toBe(200);
  });

  it("leaves delete and release without a PIN", async () => {
    const s = await start();
    await put(s, "A_KEY", "v");
    await grant(s, "A_KEY", 60);
    for (let i = 0; i < 3; i++) await grant(s, "A_KEY", 60, WRONG);
    expect((await release(s, "A_KEY")).status).toBe(200);
    expect((await call(s.socketPath, "DELETE", "/v1/secrets/A_KEY")).status).toBe(200);
  });

  it("fails vault calls with a 500 on a damaged PIN file, and keeps issuing tokens", async () => {
    const s = await start({ pin: false });
    writeFileSync(join(s.keyDir, "vault-pin.json"), "{not json");
    const second = await restart(s);
    expect((await call(second.socketPath, "GET", "/v1/secrets")).status).toBe(500);
    expect((await put(second, "A_KEY", "v")).status).toBe(500);
    expect((await call(second.socketPath, "POST", "/v1/token")).status).toBe(200);
  });

  it("logs the outcome of each refusal, reset and PIN, never the PIN", async () => {
    const s = await start();
    await put(s, "A_KEY", "v");
    await put(s, "A_KEY", "w", undefined, WRONG);
    for (let i = 0; i < 2; i++) await grant(s, "A_KEY", 60, WRONG);
    await grant(s, "A_KEY", 60, PIN);
    await reset(s, "654321");
    const entries = s.lines.map((line) => JSON.parse(line));
    expect(entries.map((e) => [e.event, e.name, e.outcome])).toEqual([
      ["vault_pin", null, "set"],
      ["vault_put", "A_KEY", "created"],
      ["vault_put", "A_KEY", "wrong_pin"],
      ["vault_grant", "A_KEY", "wrong_pin"],
      ["vault_grant", "A_KEY", "locked"],
      ["vault_grant", "A_KEY", "locked"],
      ["vault_reset", null, "reset"],
    ]);
    const text = s.lines.join("\n");
    for (const pin of [PIN, WRONG, "654321"]) expect(text).not.toContain(pin);
  });
});

describe("vault grants for several secrets", () => {
  async function withKeys() {
    const s = await start();
    for (const name of ["A_KEY", "B_KEY", "C_KEY"]) await put(s, name, `value-${name}`);
    return s;
  }

  it("grants every named secret at once, with one expiry", async () => {
    const s = await withKeys();
    expect(await grantMany(s, ["A_KEY", "B_KEY"], 900)).toEqual({
      status: 200,
      body: { names: ["A_KEY", "B_KEY"], expiresAt: new Date(T0 + 900_000).toISOString() },
    });
    expect((await release(s, "A_KEY")).status).toBe(200);
    expect((await release(s, "B_KEY")).status).toBe(200);
    // The third secret was not named.
    expect((await release(s, "C_KEY")).status).toBe(403);
  });

  it("grants nothing when one name is unknown, and counts no attempt", async () => {
    const s = await withKeys();
    const refused = await grantMany(s, ["A_KEY", "MISSING_KEY"], 900, WRONG);
    expect(refused).toEqual({
      status: 404,
      body: { error: "unknown_secret", names: ["MISSING_KEY"] },
    });
    expect((await release(s, "A_KEY")).status).toBe(403);
    expect(pinFile(s).failures).toBe(0);
  });

  it("checks the PIN once for the whole request, and grants nothing on a wrong one", async () => {
    const s = await withKeys();
    expect((await grantMany(s, ["A_KEY", "B_KEY", "C_KEY"], 900, WRONG)).body).toEqual({
      error: "wrong_pin",
      attemptsLeft: 2,
    });
    expect(pinFile(s).failures).toBe(1);
    for (const name of ["A_KEY", "B_KEY", "C_KEY"]) {
      expect((await release(s, name)).status).toBe(403);
    }
    expect((await grantMany(s, ["A_KEY", "B_KEY", "C_KEY"], 900)).status).toBe(200);
    expect(pinFile(s).failures).toBe(0);
  });

  it("refuses the whole request while locked", async () => {
    const s = await withKeys();
    for (let i = 0; i < 3; i++) await grantMany(s, ["A_KEY", "B_KEY"], 60, WRONG);
    expect((await grantMany(s, ["A_KEY", "B_KEY"], 60)).status).toBe(423);
    expect((await release(s, "A_KEY")).status).toBe(403);
  });

  it("collapses a repeated name, and still takes the legacy single name", async () => {
    const s = await withKeys();
    expect((await grantMany(s, ["A_KEY", "A_KEY"], 60)).body).toMatchObject({ names: ["A_KEY"] });
    expect((await grant(s, "B_KEY", 60)).body).toEqual({
      name: "B_KEY",
      expiresAt: new Date(T0 + 60_000).toISOString(),
    });
  });

  it.each([
    ["no names", []],
    ["eleven names", Array.from({ length: 11 }, (_, i) => `K_${i}`)],
  ])("refuses %s as a malformed request", async (_label, names) => {
    const s = await withKeys();
    expect((await grantMany(s, names, 60)).status).toBe(400);
    expect(pinFile(s).failures).toBe(0);
  });

  it("validates the ttl before the PIN for several names too", async () => {
    const s = await withKeys();
    expect((await grantMany(s, ["A_KEY", "B_KEY"], 0, WRONG)).status).toBe(400);
    expect(pinFile(s).failures).toBe(0);
  });

  it("logs one line per granted name and never the PIN or a value", async () => {
    const s = await withKeys();
    s.lines.length = 0;
    await grantMany(s, ["A_KEY", "B_KEY"], 60);
    const entries = s.lines.map((line) => JSON.parse(line));
    expect(entries.map((e) => [e.event, e.name, e.outcome])).toEqual([
      ["vault_grant", "A_KEY", "granted"],
      ["vault_grant", "B_KEY", "granted"],
    ]);
    expect(s.lines.join("\n")).not.toContain(PIN);
    expect(s.lines.join("\n")).not.toContain("value-");
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
      ["vault_pin", null, "set"],
      ["vault_put", "A_KEY", "created"],
      ["vault_grant", "A_KEY", "granted"],
      ["vault_release", "A_KEY", "released"],
      ["vault_delete", "A_KEY", "deleted"],
    ]);
    expect(s.lines.join("\n")).not.toContain("super-secret");
    expect(s.lines.join("\n")).not.toContain(PIN);
  });

  it("leaves the token endpoint working next to the vault", async () => {
    const s = await start();
    expect((await call(s.socketPath, "POST", "/v1/token")).status).toBe(200);
    expect((await call(s.socketPath, "GET", "/v1/nope")).status).toBe(404);
  });
});
