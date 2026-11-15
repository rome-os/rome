import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

// The vault: named secrets the guardian stores through Rome, plus short-lived
// grants that let a command read them. Values live only in `secrets.json` in
// the key directory, which the rome container never mounts. Grants live only in
// memory, so a restart drops them all.

const SECRETS_FILE = "secrets.json";
const MAX_BODY_BYTES = 256 * 1024;

const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_VALUE_LENGTH = 32768;
const MAX_DESCRIPTION_LENGTH = 200;
/** The longest grant the signer hands out: 3 hours. */
const MAX_GRANT_SECONDS = 10800;

interface SecretRecord {
  value: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export type Reply = (status: number, body: unknown) => void;

export interface VaultOptions {
  keyDir: string;
  now: () => number;
  log: (line: string) => void;
}

/** Writes through a temporary file and a rename, so a crash never leaves a half-written store. */
function writeStore(keyDir: string, secrets: Map<string, SecretRecord>): void {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const file = join(keyDir, SECRETS_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(secrets)), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
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
 * Returns the handler for the `/v1/secrets` and `/v1/grants` routes. The store
 * is read on first use, so a damaged file fails vault calls with a 500 and
 * leaves token issuance alone.
 */
export function createVaultHandler(options: VaultOptions) {
  const { keyDir, now, log } = options;
  let secrets: Map<string, SecretRecord> | null = null;
  const grants = new Map<string, number>();

  const entries = () => (secrets ??= readStore(keyDir));
  const record = (event: string, name: string, outcome: string) =>
    log(JSON.stringify({ at: new Date(now()).toISOString(), event, name, outcome }));
  const liveGrant = (name: string): number | null => {
    const expiresAt = grants.get(name);
    if (expiresAt === undefined) return null;
    if (expiresAt > now()) return expiresAt;
    grants.delete(name);
    return null;
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
      reply(200, { secrets: list });
      return;
    }

    if (collection === "grants" && parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      const grantName = body?.name;
      const ttl = body?.ttlSeconds;
      if (typeof grantName !== "string" || !store.has(grantName)) {
        record("vault_grant", String(grantName).slice(0, 64), "unknown");
        reply(404, { error: "unknown_secret" });
      } else if (
        typeof ttl !== "number" ||
        !Number.isInteger(ttl) ||
        ttl < 1 ||
        ttl > MAX_GRANT_SECONDS
      ) {
        record("vault_grant", grantName, "invalid_ttl");
        reply(400, { error: `ttlSeconds must be an integer from 1 to ${MAX_GRANT_SECONDS}.` });
      } else {
        const expiresAt = now() + ttl * 1000;
        grants.set(grantName, expiresAt);
        record("vault_grant", grantName, "granted");
        reply(200, { name: grantName, expiresAt: new Date(expiresAt).toISOString() });
      }
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
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE_LENGTH) {
        record("vault_put", name, "invalid_value");
        reply(400, { error: `The value must be 1 to ${MAX_VALUE_LENGTH} characters.` });
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
