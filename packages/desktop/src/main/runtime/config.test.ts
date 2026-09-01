import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  generateRuntimeEnv,
  parseSimpleEnvFile,
  resolveProxyPort,
  isPinnedRelease,
  resolveRuntimeImage,
} from "./config";

describe("generateRuntimeEnv instance token", () => {
  it("never writes ROME_INSTANCE_TOKEN — the in-VM Rome owns the token in its DB", () => {
    // The dashboard owns enrollment, so desktop never injects a Keychain token
    // into the runtime environment.
    const env = parseSimpleEnvFile(
      generateRuntimeEnv({
        publicOrigin: "http://127.0.0.1:8080",
        instanceOrigin: "http://127.0.0.1:47823",
      }),
    );
    expect(env.has("ROME_INSTANCE_TOKEN")).toBe(false);
  });
});

describe("generateRuntimeEnv session lifetime", () => {
  it("writes a ~1 year ROME_SESSION_MAX_AGE_SECONDS so the local app re-auths only at enrollment", () => {
    const env = parseSimpleEnvFile(
      generateRuntimeEnv({
        publicOrigin: "http://127.0.0.1:8080",
        instanceOrigin: "http://127.0.0.1:47823",
      }),
    );
    expect(env.get("ROME_SESSION_MAX_AGE_SECONDS")).toBe(String(60 * 60 * 24 * 365));
  });
});

describe("generateRuntimeEnv Rome Cloud origin wiring", () => {
  it("writes the single PANTHEON_BASE_ORIGIN, leaving the fetch origin for core to derive", () => {
    // There is one Rome Cloud origin. Core derives the in-VM reachable form from it
    // for server-side fetches (loopback→host.docker.internal); pinning a separate
    // origin to the host loopback would defeat that translation.
    const env = parseSimpleEnvFile(
      generateRuntimeEnv({
        publicOrigin: "http://127.0.0.1:8080",
        instanceOrigin: "http://127.0.0.1:47823",
      }),
    );
    expect(env.has("PANTHEON_BASE_ORIGIN")).toBe(true);
    expect(env.has("PANTHEON_INTERNAL_ORIGIN")).toBe(false);
  });
});

describe("generateRuntimeEnv loopback callback origin", () => {
  it("writes ROME_LOOPBACK_CALLBACK_ORIGIN so core's OAuth redirects reach the host proxy", () => {
    // Without this, core's getInstanceOrigin() falls through to
    // http://localhost:3000, which nothing on the host listens on — enrollment,
    // cloud sign-in, visitor auth and provider callbacks all send the browser
    // into a dead end.
    const env = parseSimpleEnvFile(
      generateRuntimeEnv({
        publicOrigin: "http://127.0.0.1:8080",
        instanceOrigin: "http://127.0.0.1:47823",
      }),
    );
    expect(env.get("ROME_LOOPBACK_CALLBACK_ORIGIN")).toBe("http://127.0.0.1:47823");
  });

  it("never writes PANTHEON_INSTANCE_ORIGIN — that would break the Favors return URL", () => {
    // Rome Cloud's allowReturnUrl drops any return_to host outside
    // PANTHEON_DOMAIN, loopback included, so a configured instance origin of
    // 127.0.0.1 sends the guardian to the cloud dashboard instead of home. It
    // also feeds the agent prompt and a webhook URL derivation.
    const env = parseSimpleEnvFile(
      generateRuntimeEnv({
        publicOrigin: "http://127.0.0.1:8080",
        instanceOrigin: "http://127.0.0.1:47823",
      }),
    );
    expect(env.has("PANTHEON_INSTANCE_ORIGIN")).toBe(false);
  });
});

describe("resolveRuntimeImage", () => {
  it("keeps the moving tag when nothing is pinned", () => {
    expect(resolveRuntimeImage(undefined, null)).toBe("yunfanye/rome:latest");
  });

  it("uses the baked image a release was cut with", () => {
    expect(resolveRuntimeImage(undefined, "yunfanye/rome:1.2.3")).toBe("yunfanye/rome:1.2.3");
  });

  it("lets the env override win, so a dev build can point at a local image", () => {
    expect(resolveRuntimeImage("me/rome:dev", "yunfanye/rome:1.2.3")).toBe("me/rome:dev");
  });

  it("ignores a blank override rather than pinning to an empty ref", () => {
    expect(resolveRuntimeImage("  ", "yunfanye/rome:1.2.3")).toBe("yunfanye/rome:1.2.3");
  });
});

describe("resolveProxyPort", () => {
  // stubEnv restores whatever the developer had, and unstubs even when an
  // assertion throws — mutating process.env directly leaks a bad value into
  // every later test in the file the first time one of these fails.
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  it("defaults to the fixed port so the origin is stable across launches", () => {
    rs.stubEnv("ROME_DESKTOP_PROXY_PORT", "");
    expect(resolveProxyPort()).toBe(47823);
  });

  it("honors an override so a squatted port is recoverable", () => {
    // The port binds with no fallback, so if something the user cannot quit
    // holds it, this is the lever support can pull.
    rs.stubEnv("ROME_DESKTOP_PROXY_PORT", "47900");
    expect(resolveProxyPort()).toBe(47900);
  });

  it.each(["4782x", "47823.5", "80", "70000"])("rejects %s rather than falling back", (value) => {
    // Falling back on a typo would reproduce the exact "port in use" error the
    // override was set to escape, with no hint that it was ignored.
    rs.stubEnv("ROME_DESKTOP_PROXY_PORT", value);
    expect(() => resolveProxyPort()).toThrow(/ROME_DESKTOP_PROXY_PORT/);
  });
});

describe("isPinnedRelease", () => {
  it("is true only when a release baked a reference and nothing overrode it", () => {
    expect(isPinnedRelease(undefined, "yunfanye/rome:1.0.104")).toBe(true);
  });

  it("is false for a development build", () => {
    // Nothing baked, so the app follows :latest. A new pull leaves the old
    // image dangling there, which pruning already reclaims.
    expect(isPinnedRelease(undefined, null)).toBe(false);
  });

  it("is false whenever the image was overridden", () => {
    // The override often names a locally built image with no registry copy,
    // and the releases beside it are held deliberately. Untagged counts: it
    // is still a hand-chosen ref.
    expect(isPinnedRelease("yunfanye/rome:dev2", "yunfanye/rome:1.0.104")).toBe(false);
    expect(isPinnedRelease("yunfanye/rome", null)).toBe(false);
  });

  it("treats a blank override as unset, as resolveRuntimeImage does", () => {
    expect(isPinnedRelease("   ", "yunfanye/rome:1.0.104")).toBe(true);
  });
});
