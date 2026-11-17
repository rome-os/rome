import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

// The vault: named secrets the guardian stores through Rome, plus short-lived
// grants that let a command read them. Values live only in `secrets.json` in
// the key directory, which the rome container never mounts. Grants live only in
// memory, so a restart drops them all. A 6-digit PIN, checked here and nowhere
// else, guards every write of a value and every grant: docs/vault.md#pin.

const SECRETS_FILE = "secrets.json";
const PIN_FILE = "vault-pin.json";
/** What `GET /v1/health` reports as `vault`. Version 2 is the first that enforces the PIN. */
export const VAULT_VERSION = 2;
const MAX_BODY_BYTES = 256 * 1024;

const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_VALUE_LENGTH = 32768;
const MAX_DESCRIPTION_LENGTH = 200;
/** The longest grant the signer hands out: 3 hours. */
const MAX_GRANT_SECONDS = 10800;
/** The most secrets one grant request names. */
const MAX_GRANT_NAMES = 10;
const PIN_PATTERN = /^\d{6}$/;
const MAX_PIN_FAILURES = 3;
const LOCK_MS = 15 * 60 * 1000;

interface SecretRecord {
  value: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** Hash and salt are hex. `lockedUntil` is epoch milliseconds, or null. */
interface PinRecord {
  hash: string;
  salt: string;
  failures: number;
  lockedUntil: number | null;
}

interface Refusal {
  status: number;
  body: { error: string } & Record<string, unknown>;
}

export type Reply = (status: number, body: unknown) => void;

export interface VaultOptions {
  keyDir: string;
  now: () => number;
  log: (line: string) => void;
}

/** Writes through a temporary file and a rename, so a crash never leaves a half-written file. */
function writeJsonFile(keyDir: string, name: string, data: unknown): void {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const file = join(keyDir, name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function writeStore(keyDir: string, secrets: Map<string, SecretRecord>): void {
  writeJsonFile(keyDir, SECRETS_FILE, Object.fromEntries(secrets));
}

/** Returns null when no PIN is set. Throws on a damaged file. */
function readPin(keyDir: string): PinRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(keyDir, PIN_FILE), "utf8"));
    if (
      typeof parsed?.hash !== "string" ||
      typeof parsed.salt !== "string" ||
      !Number.isInteger(parsed.failures) ||
      (parsed.lockedUntil !== null && typeof parsed.lockedUntil !== "number")
    ) {
      throw new Error(`${PIN_FILE} is damaged`);
    }
    return parsed as PinRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function newPinRecord(pin: string): PinRecord {
  const salt = randomBytes(16);
  return {
    hash: scryptSync(pin, salt, 32).toString("hex"),
    salt: salt.toString("hex"),
    failures: 0,
    lockedUntil: null,
  };
}

function readStore(keyDir: string): Map<string, SecretRecord> {
  try {
    const parsed = JSON.parse(readFileSync(join(keyDir, SECRETS_FILE), "utf8"));
    return new Map(Object.entries(parsed as Record<string, SecretRecord>));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

/** Reads a JSON object body, giving up past the size cap. Resolves null for anything else. */
function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        req.destroy();
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on("error", () => resolve(null));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(body !== null && typeof body === "object" && !Array.isArray(body) ? body : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Returns the handler for the `/v1/secrets`, `/v1/grants`, `/v1/pin` and
 * `/v1/reset` routes. The store and the PIN file are read on first use, so a
 * damaged file fails vault calls with a 500 and leaves token issuance alone.
 */
export function createVaultHandler(options: VaultOptions) {
  const { keyDir, now, log } = options;
  let secrets: Map<string, SecretRecord> | null = null;
  const grants = new Map<string, number>();

  let pinRecord: PinRecord | null | undefined;
  const entries = () => (secrets ??= readStore(keyDir));
  const currentPin = (): PinRecord | null =>
    pinRecord === undefined ? (pinRecord = readPin(keyDir)) : pinRecord;
  const savePin = (next: PinRecord) => {
    writeJsonFile(keyDir, PIN_FILE, next);
    pinRecord = next;
  };
  const lockedUntil = (): number | null => {
    const until = currentPin()?.lockedUntil ?? null;
    return until !== null && until > now() ? until : null;
  };
  const record = (event: string, name: string | null, outcome: string) =>
    log(JSON.stringify({ at: new Date(now()).toISOString(), event, name, outcome }));
  const liveGrant = (name: string): number | null => {
    const expiresAt = grants.get(name);
    if (expiresAt === undefined) return null;
    if (expiresAt > now()) return expiresAt;
    grants.delete(name);
    return null;
  };

  // Runs with no await from the read of the counter to its write, and uses the
  // synchronous scrypt, so concurrent requests take turns and a burst cannot
  // spend more than MAX_PIN_FAILURES guesses. A locked check returns before it
  // hashes, so a flood costs the signer nothing.
  const checkPin = (pin: unknown): Refusal | null => {
    if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) {
      return { status: 400, body: { error: "invalid_pin" } };
    }
    const current = currentPin();
    if (current === null) return { status: 409, body: { error: "pin_not_set" } };
    const until = lockedUntil();
    if (until !== null) {
      return { status: 423, body: { error: "locked", lockedUntil: new Date(until).toISOString() } };
    }
    const given = scryptSync(pin, Buffer.from(current.salt, "hex"), 32);
    if (timingSafeEqual(given, Buffer.from(current.hash, "hex"))) {
      if (current.failures > 0) savePin({ ...current, failures: 0, lockedUntil: null });
      return null;
    }
    const failures = current.failures + 1;
    if (failures < MAX_PIN_FAILURES) {
      savePin({ ...current, failures, lockedUntil: null });
      return {
        status: 403,
        body: { error: "wrong_pin", attemptsLeft: MAX_PIN_FAILURES - failures },
      };
    }
    const lockUntil = now() + LOCK_MS;
    savePin({ ...current, failures: 0, lockedUntil: lockUntil });
    return {
      status: 423,
      body: { error: "locked", lockedUntil: new Date(lockUntil).toISOString() },
    };
  };
  /** Replies with the refusal and returns true when the PIN does not pass. */
  const pinRefused = (pin: unknown, event: string, name: string, reply: Reply): boolean => {
    const refusal = checkPin(pin);
    if (refusal === null) return false;
    record(event, name, refusal.body.error);
    reply(refusal.status, refusal.body);
    return true;
  };

  return async (req: IncomingMessage, reply: Reply): Promise<void> => {
    const method = req.method ?? "";
    let parts: string[];
    try {
      parts = (req.url ?? "").split("?")[0].split("/").slice(2).map(decodeURIComponent);
    } catch {
      reply(404, { error: "not_found" });
      return;
    }
    const [collection, name, action] = parts;
    const store = entries();

    if (collection === "secrets" && parts.length === 1 && method === "GET") {
      const list = [...store.entries()].map(([secretName, secret]) => {
        const expiresAt = liveGrant(secretName);
        return {
          name: secretName,
          description: secret.description,
          createdAt: secret.createdAt,
          updatedAt: secret.updatedAt,
          lastUsedAt: secret.lastUsedAt,
          ...(expiresAt === null ? {} : { grantedUntil: new Date(expiresAt).toISOString() }),
        };
      });
      const until = lockedUntil();
      reply(200, {
        secrets: list,
        pin: {
          set: currentPin() !== null,
          lockedUntil: until === null ? null : new Date(until).toISOString(),
        },
      });
      return;
    }

    if (collection === "pin" && parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      if (typeof body?.pin !== "string" || !PIN_PATTERN.test(body.pin)) {
        reply(400, { error: "invalid_pin" });
      } else if (currentPin() !== null) {
        record("vault_pin", null, "already_set");
        reply(409, { error: "pin_already_set" });
      } else {
        savePin(newPinRecord(body.pin));
        record("vault_pin", null, "set");
        reply(200, { ok: true });
      }
      return;
    }

    if (collection === "reset" && parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      if (typeof body?.pin !== "string" || !PIN_PATTERN.test(body.pin)) {
        reply(400, { error: "invalid_pin" });
        return;
      }
      // The secrets go first: a failure between the two writes leaves an empty
      // vault under the old PIN, never old secrets under a PIN the caller chose.
      writeStore(keyDir, new Map());
      store.clear();
      grants.clear();
      savePin(newPinRecord(body.pin));
      record("vault_reset", null, "reset");
      reply(200, { ok: true });
      return;
    }

    if (collection === "grants" && parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      // `names` grants several secrets at once. `name` grants one.
      const asked: unknown[] = Array.isArray(body?.names) ? body.names : [body?.name];
      const ttl = body?.ttlSeconds;
      if (asked.length === 0 || asked.length > MAX_GRANT_NAMES) {
        record("vault_grant", null, "invalid_names");
        reply(400, { error: `names must list 1 to ${MAX_GRANT_NAMES} secrets.` });
        return;
      }
      const unknown = asked.filter((entry) => typeof entry !== "string" || !store.has(entry));
      if (unknown.length > 0) {
        for (const entry of unknown) record("vault_grant", String(entry).slice(0, 64), "unknown");
        reply(404, { error: "unknown_secret", names: unknown.map((entry) => String(entry)) });
        return;
      }
      const wanted = [...new Set(asked as string[])];
      const label = wanted.join(",");
      if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_GRANT_SECONDS) {
        record("vault_grant", label, "invalid_ttl");
        reply(400, { error: `ttlSeconds must be an integer from 1 to ${MAX_GRANT_SECONDS}.` });
        return;
      }
      // One PIN check covers the request, and every grant is set in this same
      // synchronous step, so a request grants all of its names or none.
      if (pinRefused(body?.pin, "vault_grant", label, reply)) return;
      const expiresAt = now() + ttl * 1000;
      for (const granted of wanted) {
        grants.set(granted, expiresAt);
        record("vault_grant", granted, "granted");
      }
      const until = new Date(expiresAt).toISOString();
      reply(
        200,
        Array.isArray(body?.names)
          ? { names: wanted, expiresAt: until }
          : { name: wanted[0], expiresAt: until },
      );
      return;
    }

    if (collection !== "secrets" || name === undefined) {
      reply(404, { error: "not_found" });
      return;
    }
    if (!SECRET_NAME_PATTERN.test(name)) {
      reply(400, { error: "invalid_name" });
      return;
    }

    if (parts.length === 2 && method === "PUT") {
      const body = await readJson(req);
      const value = body?.value;
      const description = body?.description;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_VALUE_LENGTH ||
        // A NUL cannot go in an environment variable, so `vault load` could never use the value.
        value.includes("\0")
      ) {
        record("vault_put", name, "invalid_value");
        reply(400, {
          error: `The value must be 1 to ${MAX_VALUE_LENGTH} characters, with no NUL character.`,
        });
        return;
      }
      if (
        description !== undefined &&
        (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH)
      ) {
        record("vault_put", name, "invalid_description");
        reply(400, {
          error: `The description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
        });
        return;
      }
      if (pinRefused(body?.pin, "vault_put", name, reply)) return;
      const existing = store.get(name);
      const at = new Date(now()).toISOString();
      const next: SecretRecord = {
        value,
        description: description === undefined ? (existing?.description ?? "") : description.trim(),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        lastUsedAt: existing?.lastUsedAt ?? null,
      };
      writeStore(keyDir, new Map(store).set(name, next));
      store.set(name, next);
      record("vault_put", name, existing ? "replaced" : "created");
      reply(200, { ok: true });
      return;
    }

    if (parts.length === 2 && method === "DELETE") {
      if (!store.has(name)) {
        record("vault_delete", name, "unknown");
        reply(404, { error: "unknown_secret" });
        return;
      }
      const remaining = new Map(store);
      remaining.delete(name);
      writeStore(keyDir, remaining);
      store.delete(name);
      grants.delete(name);
      record("vault_delete", name, "deleted");
      reply(200, { ok: true });
      return;
    }

    if (parts.length === 3 && action === "release" && method === "POST") {
      const secret = store.get(name);
      if (!secret) {
        record("vault_release", name, "unknown");
        reply(404, { error: "unknown_secret" });
        return;
      }
      const expiresAt = liveGrant(name);
      if (expiresAt === null) {
        record("vault_release", name, "no_grant");
        reply(403, { error: "no_grant" });
        return;
      }
      const used: SecretRecord = { ...secret, lastUsedAt: new Date(now()).toISOString() };
      writeStore(keyDir, new Map(store).set(name, used));
      store.set(name, used);
      record("vault_release", name, "released");
      reply(200, { value: secret.value, expiresAt: new Date(expiresAt).toISOString() });
      return;
    }

    reply(404, { error: "not_found" });
  };
}
