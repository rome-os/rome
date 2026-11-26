import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, rs } from "@rstest/core";
import { launchPermissionSetup } from "../host.js";

let root: string;
let appPath: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rome-setup-test-")));
  appPath = join(root, "Rome Computer Use.app");
  await mkdir(join(appPath, "Contents/MacOS"), { recursive: true });
  const executable = join(appPath, "Contents/MacOS/RomeComputerUse");
  await writeFile(executable, "");
  await chmod(executable, 0o700);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("verifies the helper and passes focused setup arguments to LaunchServices", async () => {
  const verifyBundle = rs.fn();
  const launcher = rs.fn();
  await launchPermissionSetup({
    appPath,
    pane: "screen-recording",
    locale: "zh-TW",
    verifyBundle,
    launcher,
  });
  expect(verifyBundle).toHaveBeenCalledWith(appPath, expect.any(AbortSignal));
  expect(launcher).toHaveBeenCalledWith(
    ["-n", "-a", appPath, "--args", "--setup-permissions", "screen-recording", "--locale", "zh-TW"],
    expect.any(AbortSignal),
  );
  await launchPermissionSetup({ appPath, verifyBundle, launcher });
  expect(launcher).toHaveBeenLastCalledWith(
    ["-n", "-a", appPath, "--args", "--setup-permissions"],
    expect.any(AbortSignal),
  );
});

it("never launches an invalid bundle or when verification is aborted", async () => {
  const launcher = rs.fn();
  const verifyBundle = rs.fn(() => {
    throw new Error("signature check failed");
  });
  await expect(launchPermissionSetup({ appPath, launcher, verifyBundle })).rejects.toMatchObject({
    code: "invalid_helper_bundle",
  });
  const abort = new AbortController();
  const stop = new Error("setup cancelled");
  await expect(
    launchPermissionSetup({
      appPath,
      launcher,
      verifyBundle: () => abort.abort(stop),
      signal: abort.signal,
    }),
  ).rejects.toBe(stop);
  expect(launcher).not.toHaveBeenCalled();
});

it("rejects an unsigned helper by default", async () => {
  const launcher = rs.fn();
  await expect(launchPermissionSetup({ appPath, launcher })).rejects.toMatchObject({
    code: "invalid_helper_bundle",
  });
  expect(launcher).not.toHaveBeenCalled();
});
