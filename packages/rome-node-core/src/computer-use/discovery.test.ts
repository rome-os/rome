import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, rs } from "@rstest/core";
import { discoverHelper, stagedHelperPath } from "./discovery.js";
import * as launch from "./launch.js" with { rstest: "importActual" };

const verify = rs.hoisted(() => rs.fn());
rs.mock("./launch.js", () => ({ ...launch, verifyHelperBundle: verify }));

it("pins packaged Desktop to its verified external copy even with a nested environment override", async () => {
  const home = await mkdtemp(join(tmpdir(), "rome-cu-strict-"));
  const nested = join(home, "Rome.app/Contents/Resources/native", launch.APP_NAME);
  const bundledAppPath = stagedHelperPath(home);
  const platformApp = rs.fn(() => nested);
  const options = {
    platform: "darwin" as const,
    bundledAppPath,
    strictBundledAppPath: true,
    platformApp,
    applications: [dirname(nested)],
    stagedAppPath: nested,
  };
  rs.stubEnv("ROME_NODE_COMPUTER_USE_HELPER", nested);
  try {
    await mkdir(nested, { recursive: true });
    await mkdir(bundledAppPath, { recursive: true });
    await expect(discoverHelper(options)).resolves.toBe(bundledAppPath);
    expect(verify).toHaveBeenCalledWith(bundledAppPath, expect.any(AbortSignal));
    await rm(bundledAppPath, { recursive: true });
    for (const path of [bundledAppPath, undefined]) {
      await expect(discoverHelper({ ...options, bundledAppPath: path })).rejects.toMatchObject({
        code: "computer_use_helper_missing",
      });
    }
    expect(platformApp).not.toHaveBeenCalled();
    await expect(discoverHelper({ ...options, strictBundledAppPath: false })).resolves.toBe(nested);
  } finally {
    rs.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it("falls through to the platform package when the non-strict bundled and staged paths both name a missing app", async () => {
  const home = await mkdtemp(join(tmpdir(), "rome-cu-discovery-"));
  try {
    const stagedAppPath = stagedHelperPath(home);
    const platformApp = rs.fn(() => home);
    await expect(
      discoverHelper({
        platform: "darwin",
        bundledAppPath: stagedAppPath,
        stagedAppPath,
        strictBundledAppPath: false,
        platformApp,
        applications: [],
      }),
    ).resolves.toBe(home);
    expect(platformApp).toHaveBeenCalledTimes(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
