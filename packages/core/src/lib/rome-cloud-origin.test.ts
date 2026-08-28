import { afterEach, describe, expect, it, rs } from "@rstest/core";

// The rejection cases below are expected to log. Mocking keeps that off the
// suite's stderr, where it reads as a failure rather than as the assertion, and
// gives the tests below a handle to assert the diagnostic actually fires.
const logError = rs.hoisted(() => rs.fn());
rs.mock("../logger.js", () => ({
  createLogger: () => ({ error: logError, info: rs.fn(), warn: rs.fn() }),
}));

import {
  getConfiguredInstanceOrigin,
  getInstanceOrigin,
  getRomeCloudOrigin,
} from "./rome-cloud-origin.js";

const envKeys = [
  "PANTHEON_BASE_ORIGIN",
  "PANTHEON_DOMAIN",
  "PANTHEON_SLUG",
  "PANTHEON_INSTANCE_ORIGIN",
  "ROME_LOOPBACK_CALLBACK_ORIGIN",
  "WEB_PORT",
] as const;

function clearEnv() {
  for (const key of envKeys) delete process.env[key];
}

describe("rome-cloud-origin", () => {
  const saved: Record<string, string | undefined> = {};
  for (const key of envKeys) saved[key] = process.env[key];

  afterEach(() => {
    clearEnv();
    for (const key of envKeys) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
    }
    logError.mockClear();
  });

  describe("getRomeCloudOrigin", () => {
    it("returns null when nothing is configured", () => {
      clearEnv();
      expect(getRomeCloudOrigin()).toBeNull();
    });

    it("normalizes PANTHEON_BASE_ORIGIN to just the origin", () => {
      clearEnv();
      process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.example/some/path?x=1";
      expect(getRomeCloudOrigin()).toBe("https://rome-cloud.example");
    });

    it("returns null when PANTHEON_BASE_ORIGIN is invalid", () => {
      clearEnv();
      process.env.PANTHEON_BASE_ORIGIN = "not a url";
      expect(getRomeCloudOrigin()).toBeNull();
    });

    it("derives an https origin from PANTHEON_DOMAIN", () => {
      clearEnv();
      process.env.PANTHEON_DOMAIN = "rome-cloud.example";
      expect(getRomeCloudOrigin()).toBe("https://rome-cloud.example");
    });
  });

  describe("getConfiguredInstanceOrigin", () => {
    it("derives <slug>.<domain> from slug + PANTHEON_DOMAIN", () => {
      clearEnv();
      process.env.PANTHEON_SLUG = "acme";
      process.env.PANTHEON_DOMAIN = "romeos.cc";
      expect(getConfiguredInstanceOrigin()).toBe("https://acme.romeos.cc");
    });

    it("trims leading/trailing dots on PANTHEON_DOMAIN", () => {
      clearEnv();
      process.env.PANTHEON_SLUG = "acme";
      process.env.PANTHEON_DOMAIN = ".romeos.cc.";
      expect(getConfiguredInstanceOrigin()).toBe("https://acme.romeos.cc");
    });

    it("returns null when slug or domain is missing", () => {
      clearEnv();
      expect(getConfiguredInstanceOrigin()).toBeNull();
      process.env.PANTHEON_SLUG = "acme";
      expect(getConfiguredInstanceOrigin()).toBeNull();
      delete process.env.PANTHEON_SLUG;
      process.env.PANTHEON_DOMAIN = "romeos.cc";
      expect(getConfiguredInstanceOrigin()).toBeNull();
    });

    it("prefers explicit PANTHEON_INSTANCE_ORIGIN over the derived value", () => {
      clearEnv();
      process.env.PANTHEON_SLUG = "acme";
      process.env.PANTHEON_DOMAIN = "romeos.cc";
      process.env.PANTHEON_INSTANCE_ORIGIN = "https://custom.example/path";
      expect(getConfiguredInstanceOrigin()).toBe("https://custom.example");
    });

    it("returns null when PANTHEON_INSTANCE_ORIGIN is invalid", () => {
      clearEnv();
      process.env.PANTHEON_INSTANCE_ORIGIN = "not a url";
      expect(getConfiguredInstanceOrigin()).toBeNull();
    });
  });

  describe("getInstanceOrigin", () => {
    it("uses the explicit PANTHEON_INSTANCE_ORIGIN authoritatively", () => {
      clearEnv();
      process.env.PANTHEON_INSTANCE_ORIGIN = "https://acme.romeos.dev";
      expect(getInstanceOrigin()).toBe("https://acme.romeos.dev");
    });

    it("uses the derived <slug>.<domain> origin when configured", () => {
      clearEnv();
      process.env.PANTHEON_SLUG = "acme";
      process.env.PANTHEON_DOMAIN = "romeos.cc";
      expect(getInstanceOrigin()).toBe("https://acme.romeos.cc");
    });

    it("falls back to the local loopback origin from WEB_PORT", () => {
      clearEnv();
      process.env.WEB_PORT = "4321";
      expect(getInstanceOrigin()).toBe("http://localhost:4321");
    });

    it("defaults the loopback port to 3000 when WEB_PORT is unset", () => {
      clearEnv();
      expect(getInstanceOrigin()).toBe("http://localhost:3000");
    });

    it("never infers from a request — no configured origin means loopback, not a host", () => {
      clearEnv();
      // With nothing configured the instance states its own loopback address,
      // rather than trusting a (spoofable) forwarded host.
      expect(getInstanceOrigin().startsWith("http://localhost:")).toBe(true);
    });

    it("prefers the loopback callback origin over every other source", () => {
      clearEnv();
      // The desktop app serves Rome through a host-side loopback proxy this
      // process cannot observe. Without this source the callback lands on
      // http://localhost:3000, where nothing on the host listens.
      //
      // PANTHEON_INSTANCE_ORIGIN is the explicit, highest-precedence competitor,
      // so set it too — an operator hand-editing it into a desktop env file must
      // not silently disable the fix.
      process.env.ROME_LOOPBACK_CALLBACK_ORIGIN = "http://127.0.0.1:47823";
      process.env.PANTHEON_INSTANCE_ORIGIN = "https://acme.romeos.cc";
      process.env.PANTHEON_SLUG = "acme";
      process.env.PANTHEON_DOMAIN = "romeos.cc";
      expect(getInstanceOrigin()).toBe("http://127.0.0.1:47823");
    });

    it("falls through when the loopback callback origin is empty or blank", () => {
      clearEnv();
      // The likeliest way the desktop side gets this wrong is writing the key
      // with no value, which must behave exactly like not writing it at all.
      process.env.WEB_PORT = "8080";
      for (const blank of ["", "   "]) {
        process.env.ROME_LOOPBACK_CALLBACK_ORIGIN = blank;
        expect(getInstanceOrigin()).toBe("http://localhost:8080");
      }
    });

    it("keeps the origin and drops path and query", () => {
      clearEnv();
      // The variable names an origin, so a path is a category error rather than
      // a dangerous value — reading past it gives the right answer.
      process.env.ROME_LOOPBACK_CALLBACK_ORIGIN = "http://127.0.0.1:47823/evil?x=1";
      expect(getInstanceOrigin()).toBe("http://127.0.0.1:47823");
    });

    it.each([
      ["a malformed value", "not a url", "unparseable"],
      ["a remote https origin", "https://attacker.example", "not_http"],
      ["a LAN address", "http://192.168.1.20:47823", "not_loopback"],
      ["an https loopback origin", "https://127.0.0.1:47823", "not_http"],
      // No port resolves to 80 and port 0 cannot be dialled. Both are dead ends
      // that look exactly like the bug this variable exists to fix.
      ["a loopback origin with no port", "http://127.0.0.1", "no_usable_port"],
      ["port zero", "http://127.0.0.1:0", "no_usable_port"],
      // Credentials are never part of a callback origin. Their presence means
      // the value was assembled wrong, so say so instead of quietly dropping it.
      ["embedded credentials", "http://user:pass@127.0.0.1:47823", "has_credentials"],
    ])("ignores %s rather than trusting it as a callback target", (_label, value, expectedReason) => {
      clearEnv();
      // This value becomes the redirect_uri an OAuth authorization code is
      // delivered to, so anything that is not a plain http loopback origin has
      // to fall through instead of being honored.
      process.env.ROME_LOOPBACK_CALLBACK_ORIGIN = value;
      process.env.WEB_PORT = "8080";
      expect(getInstanceOrigin()).toBe("http://localhost:8080");
      // Falling back silently would reproduce the dead-end this variable
      // exists to fix, so the diagnostic is part of the contract — and the
      // reason has to distinguish the cases, or it cannot guide a fix.
      expect(logError).toHaveBeenCalledWith("ignoring ROME_LOOPBACK_CALLBACK_ORIGIN", {
        reason: expectedReason,
      });
    });

    it.each([
      ["a valid origin", "http://127.0.0.1:47823"],
      ["an unset variable", undefined],
      ["a blank value", "   "],
    ])("stays quiet for %s", (_label, value) => {
      clearEnv();
      // getInstanceOrigin runs on every OAuth redirect, so a normal
      // configuration must not log on each one.
      if (value !== undefined) process.env.ROME_LOOPBACK_CALLBACK_ORIGIN = value;
      getInstanceOrigin();
      expect(logError).not.toHaveBeenCalled();
    });
  });

  describe("getConfiguredInstanceOrigin with a loopback callback origin", () => {
    it("stays null so the Favors return URL and the prompt keep their own source", () => {
      clearEnv();
      // Rome Cloud's Favors allowlist rejects any return_to host outside
      // PANTHEON_DOMAIN, loopback included, and the configured origin also
      // feeds PromptBuilder. Keeping it null preserves both.
      process.env.ROME_LOOPBACK_CALLBACK_ORIGIN = "http://127.0.0.1:47823";
      expect(getConfiguredInstanceOrigin()).toBeNull();
    });
  });
});
