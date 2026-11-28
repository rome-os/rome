import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, rs } from "@rstest/core";
import { launchPermissionSetup, stagedHelperPath } from "../host.js";

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

function optionValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) throw new Error(`missing ${flag}`);
  return args[index + 1]!;
}

it("verifies the helper and waits for readiness through LaunchServices", async () => {
  const verifyBundle = rs.fn();
  const launcher = rs.fn(async (args: string[]) => {
    await writeFile(optionValue(args, "--stdout"), "ready\n");
  });
  await launchPermissionSetup({
    appPath,
    pane: "screen-recording",
    locale: "zh-TW",
    verifyBundle,
    launcher,
  });
  expect(verifyBundle).toHaveBeenCalledWith(appPath, expect.any(AbortSignal));
  expect(launcher).toHaveBeenCalledWith(
    [
      "-n",
      "--stdout",
      expect.stringMatching(/stdout\.txt$/),
      "--stderr",
      expect.stringMatching(/stderr\.txt$/),
      "-a",
      appPath,
      "--args",
      "--setup-permissions",
      "screen-recording",
      "--locale",
      "zh-TW",
    ],
    expect.any(AbortSignal),
  );
  await launchPermissionSetup({ appPath, verifyBundle, launcher });
  expect(launcher).toHaveBeenLastCalledWith(
    [
      "-n",
      "--stdout",
      expect.stringMatching(/stdout\.txt$/),
      "--stderr",
      expect.stringMatching(/stderr\.txt$/),
      "-a",
      appPath,
      "--args",
      "--setup-permissions",
    ],
    expect.any(AbortSignal),
  );
});

it("surfaces helper-side startup failures and timeouts to callers", async () => {
  const verifyBundle = rs.fn();
  await expect(
    launchPermissionSetup({
      appPath,
      verifyBundle,
      launcher: async (args) => {
        await writeFile(optionValue(args, "--stderr"), "invalid_request\n");
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    launchPermissionSetup({
      appPath,
      verifyBundle,
      launcher: async (args) => {
        await writeFile(optionValue(args, "--stderr"), "permission_setup_unavailable\n");
      },
    }),
  ).rejects.toMatchObject({ code: "internal_error" });
  await expect(
    launchPermissionSetup({
      appPath,
      verifyBundle,
      startupTimeoutMs: 60,
      launcher: async () => {},
    }),
  ).rejects.toMatchObject({ code: "startup_timeout" });
  await expect(
    launchPermissionSetup({
      appPath,
      verifyBundle,
      launcher: async (args) => {
        await writeFile(optionValue(args, "--stderr"), "AppKit diagnostic warning\n");
        await writeFile(optionValue(args, "--stdout"), "ready\n");
      },
    }),
  ).resolves.toBeUndefined();
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

it("rejects a staged path redirected after discovery, even to a valid helper", async () => {
  rs.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", root);
  try {
    const staged = stagedHelperPath(root);
    await mkdir(dirname(staged), { recursive: true });
    await symlink(appPath, staged, "junction");
    const launcher = rs.fn();
    await expect(
      launchPermissionSetup({ appPath: staged, verifyBundle: () => {}, launcher }),
    ).rejects.toMatchObject({ code: "invalid_helper_bundle" });
    expect(launcher).not.toHaveBeenCalled();
  } finally {
    rs.unstubAllEnvs();
  }
});
