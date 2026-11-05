import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

const KEY_FILE = "signer-key.jwk";
const TOKEN_LIFETIME_SECONDS = 60;
const RATE_LIMIT_PER_SECOND = 20;

export interface SignerOptions {
  /** The Rome Cloud origin every token is issued for. Callers cannot choose it. */
  audience: string;
  keyDir: string;
  socketPath: string;
  /** Epoch milliseconds. Tests only. */
  now?: () => number;
  /** One line per issued token. Defaults to stdout. */
  log?: (line: string) => void;
}

function loadPrivateKey(keyDir: string): KeyObject {
  const file = join(keyDir, KEY_FILE);
  try {
    return createPrivateKey({ key: JSON.parse(readFileSync(file, "utf8")), format: "jwk" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(file, JSON.stringify(privateKey.export({ format: "jwk" })), {
    mode: 0o600,
    flag: "wx",
  });
  return privateKey;
}

/** Reduces a configured Rome Cloud address to its origin, or throws when it is not an http(s) URL. */
export function normalizeAudience(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("The audience must be an http(s) origin.");
  return url.origin;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Starts the signer. It issues 60-second ES256 tokens and signs nothing else. */
export async function startSigner(
  options: SignerOptions,
): Promise<{ server: Server; jkt: string }> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const privateKey = loadPrivateKey(options.keyDir);
  const { kty, crv, x, y } = createPublicKey(privateKey).export({ format: "jwk" });
  // RFC 7638: members in lexicographic order.
  const jkt = createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
  const header = encode({ alg: "ES256", typ: "JWT", kid: jkt, jwk: { kty, crv, x, y } });

  let recent: number[] = [];
  const issue = (): string | null => {
    const at = now();
    recent = recent.filter((issuedAt) => at - issuedAt < 1000);
    if (recent.length >= RATE_LIMIT_PER_SECOND) return null;
    recent.push(at);
    const iat = Math.floor(at / 1000);
    const jti = randomBytes(12).toString("base64url");
    const input = `${header}.${encode({
      aud: options.audience,
      iat,
      exp: iat + TOKEN_LIFETIME_SECONDS,
      jti,
    })}`;
    const signature = sign("sha256", Buffer.from(input), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    log(JSON.stringify({ at: new Date(at).toISOString(), jti }));
    return `${input}.${signature.toString("base64url")}`;
  };

  const server = createServer((req, res) => {
    req.resume();
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/v1/token") {
      const token = issue();
      if (token) reply(200, { token });
      else reply(429, { error: "rate_limited" });
    } else if (req.method === "GET" && req.url === "/v1/health") {
      reply(200, { ok: true, jkt, aud: options.audience });
    } else {
      reply(404, { error: "not_found" });
    }
  });
  rmSync(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });
  // Who may connect is decided by which containers mount the socket volume.
  chmodSync(options.socketPath, 0o666);
  return { server, jkt };
}
