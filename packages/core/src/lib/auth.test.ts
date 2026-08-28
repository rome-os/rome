import { describe, it, expect, afterEach, beforeEach, rs } from "@rstest/core";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  shouldSecureCookie,
  hashPassword,
  verifyPassword,
  createSession,
  issueGuardianSession,
  verifySession,
  createSessionHandoffToken,
  verifySessionHandoffToken,
  COOKIE_NAME,
} from "./auth.js";

describe("shouldSecureCookie", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecure = process.env.ROME_COOKIE_SECURE;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSecure === undefined) delete process.env.ROME_COOKIE_SECURE;
    else process.env.ROME_COOKIE_SECURE = originalSecure;
  });

  it("returns false in non-production", () => {
    process.env.NODE_ENV = "development";
    expect(shouldSecureCookie()).toBe(false);
  });

  it("honours x-forwarded-proto via a Hono-style header accessor", () => {
    process.env.NODE_ENV = "production";
    const req = { header: (n: string) => (n === "x-forwarded-proto" ? "https" : undefined) };
    expect(shouldSecureCookie(req)).toBe(true);
    const httpReq = { header: () => "http" };
    expect(shouldSecureCookie(httpReq)).toBe(false);
  });

  it("honours x-forwarded-proto via a fetch-Request-style headers map", () => {
    process.env.NODE_ENV = "production";
    const headers = { get: (n: string) => (n === "x-forwarded-proto" ? "https" : null) };
    expect(shouldSecureCookie({ headers })).toBe(true);
  });

  it("returns false when ROME_COOKIE_SECURE is explicitly 'false'", () => {
    process.env.NODE_ENV = "production";
    process.env.ROME_COOKIE_SECURE = "false";
    expect(shouldSecureCookie()).toBe(false);
  });

  it("defaults to true in production with no hints", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ROME_COOKIE_SECURE;
    expect(shouldSecureCookie()).toBe(true);
  });
});

describe("password hashing", () => {
  it("hashPassword produces a bcrypt string that verifyPassword accepts", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(await verifyPassword("hunter2", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  }, 20_000);
});

describe("session tokens", () => {
  beforeEach(() => {
    process.env.ROME_JWT_SECRET = "test-secret";
  });

  it("createSession round-trips via verifySession", () => {
    const token = createSession("u1");
    expect(verifySession(token)).toEqual({ userId: "u1" });
  });

  it("verifySession returns null for garbage", () => {
    expect(verifySession("not-a-jwt")).toBeNull();
  });
});

describe("issueGuardianSession", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecure = process.env.ROME_COOKIE_SECURE;

  beforeEach(() => {
    process.env.ROME_JWT_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSecure === undefined) delete process.env.ROME_COOKIE_SECURE;
    else process.env.ROME_COOKIE_SECURE = originalSecure;
  });

  /** Everything after the leading `name=value;` — the attribute flags. */
  function attributesOf(setCookieHeader: string): string[] {
    return setCookieHeader
      .split(";")
      .slice(1)
      .map((part) => part.trim());
  }

  async function setCookieFrom(handler: (c: import("hono").Context) => void): Promise<string> {
    const app = new Hono();
    app.get("/issue", (c) => {
      handler(c);
      return c.body(null, 204);
    });
    const res = await app.request("/issue", {
      headers: { "x-forwarded-proto": "https" },
    });
    const header = res.headers.get("set-cookie");
    expect(header).toBeTruthy();
    return header as string;
  }

  it("emits a cookie byte-identical to the prior inline setCookie call (non-production)", async () => {
    process.env.NODE_ENV = "development";

    const helperHeader = await setCookieFrom((c) => issueGuardianSession(c, "u1"));
    const inlineHeader = await setCookieFrom((c) =>
      setCookie(c, COOKIE_NAME, createSession("u1"), {
        httpOnly: true,
        secure: shouldSecureCookie(c.req.raw),
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      }),
    );

    // Attribute flags must match byte-for-byte; the JWT value differs per call
    // (fresh iat), so it's asserted separately below.
    expect(attributesOf(helperHeader)).toEqual(attributesOf(inlineHeader));
    expect(helperHeader.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    expect([...attributesOf(helperHeader)].sort()).toEqual([
      "HttpOnly",
      "Max-Age=2592000",
      "Path=/",
      "SameSite=Lax",
    ]);

    const value = helperHeader.slice(`${COOKIE_NAME}=`.length).split(";")[0];
    expect(verifySession(decodeURIComponent(value))).toEqual({ userId: "u1" });
  });

  it("matches the prior inline call's Secure flag in production over https", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ROME_COOKIE_SECURE;

    const helperHeader = await setCookieFrom((c) => issueGuardianSession(c, "u1"));
    const inlineHeader = await setCookieFrom((c) =>
      setCookie(c, COOKIE_NAME, createSession("u1"), {
        httpOnly: true,
        secure: shouldSecureCookie(c.req.raw),
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      }),
    );

    expect(attributesOf(helperHeader)).toEqual(attributesOf(inlineHeader));
    expect(attributesOf(helperHeader)).toContain("Secure");
  });
});

describe("configurable session lifetime", () => {
  // SESSION_MAX_AGE_SECONDS is read at module load, so each case re-imports the
  // module with the env set first (rs.resetModules + dynamic import).
  const original = process.env.ROME_SESSION_MAX_AGE_SECONDS;

  afterEach(() => {
    if (original === undefined) delete process.env.ROME_SESSION_MAX_AGE_SECONDS;
    else process.env.ROME_SESSION_MAX_AGE_SECONDS = original;
    rs.resetModules();
  });

  async function maxAgeOf(): Promise<string | undefined> {
    const mod = await import("./auth.js");
    const app = new Hono();
    app.get("/issue", (c) => {
      mod.issueGuardianSession(c, "u1");
      return c.body(null, 204);
    });
    const res = await app.request("/issue");
    const header = res.headers.get("set-cookie") ?? "";
    return header
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("Max-Age="));
  }

  it("uses the ~1 year override from ROME_SESSION_MAX_AGE_SECONDS (desktop)", async () => {
    process.env.ROME_SESSION_MAX_AGE_SECONDS = String(60 * 60 * 24 * 365);
    rs.resetModules();
    expect(await maxAgeOf()).toBe("Max-Age=31536000");
  });

  it("falls back to the 30-day default when unset (cloud)", async () => {
    delete process.env.ROME_SESSION_MAX_AGE_SECONDS;
    rs.resetModules();
    expect(await maxAgeOf()).toBe("Max-Age=2592000");
  });
});

describe("session handoff tokens", () => {
  it("round-trips a valid handoff token", () => {
    const token = createSessionHandoffToken({
      userId: "u1",
      targetHost: "host.example",
      nonce: "n1",
    });
    expect(verifySessionHandoffToken(token)).toEqual({
      kind: "session_handoff",
      userId: "u1",
      targetHost: "host.example",
      nonce: "n1",
    });
  });

  it("rejects tokens with the wrong kind", () => {
    const token = createSession("u1");
    expect(verifySessionHandoffToken(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifySessionHandoffToken("not-a-jwt")).toBeNull();
  });
});
