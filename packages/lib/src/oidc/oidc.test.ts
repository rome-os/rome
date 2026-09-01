import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "@rstest/core";
import jwt from "jsonwebtoken";
import {
  buildDiscoveryMetadata,
  deriveKid,
  publicKeyToJwk,
  signIdToken,
  verifyIdToken,
} from "./index";

const ISSUER = "https://issuer.example";
const AUDIENCE = "rome-instance";
const JWKS_URI = "https://issuer.example/oauth2/jwks";

// Fresh kid per key so the module-level verify cache never bleeds between cases.
let seq = 0;
function freshKey(): { privateKey: KeyObject; publicKey: KeyObject; kid: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicKey, kid: `k${seq++}` };
}

function jwksFetch(jwks: Array<Record<string, unknown>>, counter?: { n: number }): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = String(input instanceof URL ? input : ((input as Request).url ?? input));
    if (url.endsWith("/oauth2/jwks")) {
      if (counter) counter.n++;
      return new Response(JSON.stringify({ keys: jwks }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("deriveKid", () => {
  it("is a stable 16-hex id derived from the key", () => {
    const { publicKey } = freshKey();
    const kid = deriveKid(publicKey);
    expect(kid).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveKid(publicKey)).toBe(kid);
  });

  it("differs for different keys", () => {
    expect(deriveKid(freshKey().publicKey)).not.toBe(deriveKid(freshKey().publicKey));
  });
});

describe("publicKeyToJwk", () => {
  it("publishes the EC public fields plus kid/use/alg and never the private scalar", () => {
    const { publicKey } = freshKey();
    const jwk = publicKeyToJwk(publicKey, "kid-1");
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk).toMatchObject({ kid: "kid-1", use: "sig", alg: "ES256" });
    expect(jwk.d).toBeUndefined();
  });
});

describe("signIdToken + verifyIdToken", () => {
  it("round-trips with sub/email/nonce through the JWKS", async () => {
    const key = freshKey();
    const token = signIdToken({
      privateKey: key.privateKey,
      kid: key.kid,
      subject: "acct-1",
      audience: AUDIENCE,
      issuer: ISSUER,
      expiresInSeconds: 300,
      nonce: "n1",
      email: "a@b.com",
      picture: "https://example.com/avatar.png",
    });
    const result = await verifyIdToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: "n1",
      jwksUri: JWKS_URI,
      fetch: jwksFetch([publicKeyToJwk(key.publicKey, key.kid)]),
    });
    expect(result.sub).toBe("acct-1");
    expect(result.email).toBe("a@b.com");
    expect(result.picture).toBe("https://example.com/avatar.png");
    expect(result.payload.aud).toBe(AUDIENCE);
  });

  it("caches the key by kid (one JWKS fetch across two verifies)", async () => {
    const key = freshKey();
    const counter = { n: 0 };
    const opts = {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: JWKS_URI,
      fetch: jwksFetch([publicKeyToJwk(key.publicKey, key.kid)], counter),
    };
    const mk = () =>
      signIdToken({
        privateKey: key.privateKey,
        kid: key.kid,
        subject: "s",
        audience: AUDIENCE,
        issuer: ISSUER,
        expiresInSeconds: 300,
      });
    await verifyIdToken(mk(), opts);
    await verifyIdToken(mk(), opts);
    expect(counter.n).toBe(1);
  });

  it("re-fetches after the cache-control TTL and stops serving a revoked kid", async () => {
    const key = freshKey();
    let served: Array<Record<string, unknown>> = [publicKeyToJwk(key.publicKey, key.kid)];
    const counter = { n: 0 };
    // max-age=0 → every entry is immediately stale, so each verify re-fetches.
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = String(input instanceof URL ? input : ((input as Request).url ?? input));
      if (url.endsWith("/oauth2/jwks")) {
        counter.n++;
        return new Response(JSON.stringify({ keys: served }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "public, max-age=0" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const opts = { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI, fetch: fetchImpl };
    const mk = () =>
      signIdToken({
        privateKey: key.privateKey,
        kid: key.kid,
        subject: "s",
        audience: AUDIENCE,
        issuer: ISSUER,
        expiresInSeconds: 300,
      });

    await verifyIdToken(mk(), opts);
    await verifyIdToken(mk(), opts);
    expect(counter.n).toBe(2); // TTL=0 forced a refetch on the second verify

    // The issuer drops the compromised kid from JWKS → verification fails closed
    // within the TTL window, without a process restart.
    served = [];
    await expect(verifyIdToken(mk(), opts)).rejects.toThrow();
  });

  it("rejects unknown kid, bad signature, wrong iss/aud, nonce mismatch, expiry", async () => {
    const key = freshKey();
    const jwks = jwksFetch([publicKeyToJwk(key.publicKey, key.kid)]);
    const base = { audience: AUDIENCE, issuer: ISSUER, jwksUri: JWKS_URI, fetch: jwks };
    const mk = (over: Partial<Parameters<typeof signIdToken>[0]> = {}) =>
      signIdToken({
        privateKey: key.privateKey,
        kid: key.kid,
        subject: "s",
        audience: AUDIENCE,
        issuer: ISSUER,
        expiresInSeconds: 300,
        ...over,
      });

    // Unknown kid: token's kid absent from the served set.
    const other = freshKey();
    await expect(
      verifyIdToken(mk(), {
        ...base,
        fetch: jwksFetch([publicKeyToJwk(other.publicKey, other.kid)]),
      }),
    ).rejects.toThrow();

    // Bad signature: signed by a different key but claiming the real kid.
    const impostor = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    await expect(verifyIdToken(mk({ privateKey: impostor }), base)).rejects.toThrow();

    await expect(verifyIdToken(mk({ issuer: "https://evil" }), base)).rejects.toThrow();
    await expect(verifyIdToken(mk({ audience: "other" }), base)).rejects.toThrow();
    await expect(
      verifyIdToken(mk({ nonce: "real" }), { ...base, nonce: "expected" }),
    ).rejects.toThrow();
    await expect(verifyIdToken(mk({ expiresInSeconds: -10 }), base)).rejects.toThrow();
  });

  it("decode-only sanity: header carries the kid", () => {
    const key = freshKey();
    const token = signIdToken({
      privateKey: key.privateKey,
      kid: key.kid,
      subject: "s",
      audience: AUDIENCE,
      issuer: ISSUER,
      expiresInSeconds: 300,
    });
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === "string") throw new Error("bad token");
    expect(decoded.header.kid).toBe(key.kid);
    expect(decoded.header.alg).toBe("ES256");
  });
});

describe("buildDiscoveryMetadata", () => {
  it("derives endpoints from issuer and advertises the implemented surface", () => {
    const meta = buildDiscoveryMetadata({
      issuer: "https://i.example",
      scopesSupported: ["openid", "instance:enroll"],
    });
    expect(meta).toMatchObject({
      issuer: "https://i.example",
      authorization_endpoint: "https://i.example/oauth2/authorize",
      token_endpoint: "https://i.example/oauth2/token",
      jwks_uri: "https://i.example/oauth2/jwks",
      id_token_signing_alg_values_supported: ["ES256"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "instance:enroll"],
    });
  });
});
