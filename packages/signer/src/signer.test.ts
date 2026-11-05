import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { normalizeAudience, startSigner } from "./signer.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function start(overrides: { now?: () => number; log?: (line: string) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "signer-"));
  const options = {
    audience: "https://cloud.example",
    keyDir: join(dir, "keys"),
    socketPath: join(dir, "signer.sock"),
    log: () => {},
    ...overrides,
  };
  const signer = await startSigner(options);
  cleanups.push(() => {
    signer.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...signer, ...options };
}

function call(socketPath: string, method: string, path: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("normalizeAudience", () => {
  it.each([
    ["https://romeos.cc", "https://romeos.cc"],
    ["https://romeos.cc/", "https://romeos.cc"],
    ["https://romeos.cc/some/path?x=1", "https://romeos.cc"],
    ["http://localhost:3000/", "http://localhost:3000"],
  ])("reduces %s to its origin", (value, origin) => {
    expect(normalizeAudience(value)).toBe(origin);
  });

  it.each(["romeos.cc", "ftp://romeos.cc", ""])("rejects %j", (value) => {
    expect(() => normalizeAudience(value)).toThrow();
  });
});

describe("signer", () => {
  it("issues a token that satisfies the Rome Cloud contract", async () => {
    const { socketPath, jkt } = await start();
    const { status, body } = await call(socketPath, "POST", "/v1/token");
    expect(status).toBe(200);
    const token = body.token as string;
    expect(token.length).toBeLessThanOrEqual(2048);
    const [h, p, s] = token.split(".");
    const header = decode(h);
    const payload = decode(p);
    expect(Object.keys(header)).toEqual(["alg", "typ", "kid", "jwk"]);
    expect(header).toMatchObject({ alg: "ES256", typ: "JWT", kid: jkt });
    expect(Object.keys(header.jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    const { crv, kty, x, y } = header.jwk;
    expect(header.kid).toBe(
      createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url"),
    );
    expect(header.kid).toHaveLength(43);
    expect(payload.aud).toBe("https://cloud.example");
    expect(payload.exp - payload.iat).toBe(60);
    expect(typeof payload.jti).toBe("string");
    const signature = Buffer.from(s, "base64url");
    expect(signature).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        signature,
      ),
    ).toBe(true);
  });

  it("serves health with the key thumbprint and audience, and only the two endpoints", async () => {
    const { socketPath, jkt } = await start();
    expect(await call(socketPath, "GET", "/v1/health")).toEqual({
      status: 200,
      body: { ok: true, jkt, aud: "https://cloud.example" },
    });
    expect((await call(socketPath, "GET", "/v1/token")).status).toBe(404);
    expect((await call(socketPath, "POST", "/v1/sign")).status).toBe(404);
    expect((await call(socketPath, "GET", "/v1/key")).status).toBe(404);
  });

  it("stores the key with mode 0600 and reuses it on restart", async () => {
    const first = await start();
    expect(statSync(join(first.keyDir, "signer-key.jwk")).mode & 0o777).toBe(0o600);
    first.server.close();
    const second = await startSigner({
      audience: first.audience,
      keyDir: first.keyDir,
      socketPath: first.socketPath,
    });
    cleanups.push(() => second.server.close());
    expect(second.jkt).toBe(first.jkt);
  });

  it("limits issuance to 20 tokens per second and logs jti only", async () => {
    let clock = 1_700_000_000_000;
    const lines: string[] = [];
    const { socketPath } = await start({ now: () => clock, log: (line) => lines.push(line) });
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push((await call(socketPath, "POST", "/v1/token")).status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(20);
    expect(statuses[20]).toBe(429);
    clock += 1000;
    expect((await call(socketPath, "POST", "/v1/token")).status).toBe(200);
    expect(lines).toHaveLength(21);
    const entry = JSON.parse(lines[0]);
    expect(Object.keys(entry)).toEqual(["at", "jti"]);
    expect(lines.join("")).not.toContain("eyJ");
  });

  it("makes the socket reachable by other users", async () => {
    const { socketPath } = await start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o666);
  });
});
