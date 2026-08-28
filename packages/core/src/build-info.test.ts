import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

// getBuildInfo caches at module scope, so each case re-imports the module fresh
// after setting the environment it should observe.
async function freshGetBuildInfo() {
  rs.resetModules();
  const mod = await import("./build-info.js");
  return mod.getBuildInfo();
}

describe("getBuildInfo", () => {
  const original = {
    version: process.env.ROME_VERSION,
    sha: process.env.ROME_BUILD_SHA,
    time: process.env.ROME_BUILD_TIME,
  };

  beforeEach(() => {
    delete process.env.ROME_VERSION;
    delete process.env.ROME_BUILD_SHA;
    delete process.env.ROME_BUILD_TIME;
  });

  afterEach(() => {
    if (original.version === undefined) delete process.env.ROME_VERSION;
    else process.env.ROME_VERSION = original.version;
    if (original.sha === undefined) delete process.env.ROME_BUILD_SHA;
    else process.env.ROME_BUILD_SHA = original.sha;
    if (original.time === undefined) delete process.env.ROME_BUILD_TIME;
    else process.env.ROME_BUILD_TIME = original.time;
  });

  it("reports the injected version, build SHA, and time when the env is frozen at build", async () => {
    process.env.ROME_VERSION = "0.5.0";
    process.env.ROME_BUILD_SHA = "abc1234";
    process.env.ROME_BUILD_TIME = "2026-06-01T12:00:00Z";

    expect(await freshGetBuildInfo()).toEqual({
      version: "0.5.0",
      sha: "abc1234",
      builtAt: "2026-06-01T12:00:00Z",
    });
  });

  it("reports a null version on a non-release build that still has a SHA", async () => {
    process.env.ROME_BUILD_SHA = "deadbee";

    expect(await freshGetBuildInfo()).toEqual({ version: null, sha: "deadbee", builtAt: null });
  });

  it("reports nulls when no build env is set", async () => {
    expect(await freshGetBuildInfo()).toEqual({ version: null, sha: null, builtAt: null });
  });

  it("treats a whitespace-only ROME_VERSION as absent", async () => {
    process.env.ROME_VERSION = "   ";

    expect(await freshGetBuildInfo()).toEqual({ version: null, sha: null, builtAt: null });
  });
});
