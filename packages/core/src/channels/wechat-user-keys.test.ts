import { mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "@rstest/core";
import { recoverWechatPassphrase, stageCaptureDriver } from "./wechat-user-keys.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
it("stages private drivers and rejects a symlinked home", async () => {
  const home = await mkdtemp(join(tmpdir(), "wechat-stage-"));
  homes.push(home);
  const dir = await stageCaptureDriver(home);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  for (const file of await readdir(dir))
    expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
  await symlink(home, join(home, "alias"));
  await expect(stageCaptureDriver(join(home, "alias"))).rejects.toThrow("private parent");
});
it("runs the staged driver in-process and parses the passphrase", async () => {
  let file = "";
  let args: string[] = [];
  let env: Record<string, string> | undefined;
  const result = await recoverWechatPassphrase(
    { driverDir: "/private/capture", home: "/home/rome", runtimeDir: "/run/user/999" },
    undefined,
    async (f, a, opts) => {
      file = f;
      args = a;
      env = opts?.env;
      return { code: 0, stdout: `PASSPHRASE ${"ab".repeat(32)}`, stderr: "" };
    },
  );
  expect(result).toBe("ab".repeat(32));
  expect(file).toBe("python3");
  expect(args[0]).toBe("/private/capture/launch-driver.py");
  expect(env).toEqual({ HOME: "/home/rome", XDG_RUNTIME_DIR: "/run/user/999" });
});
it("rejects a capture that exits non-zero or yields no passphrase", async () => {
  await expect(
    recoverWechatPassphrase({ driverDir: "/private/capture" }, undefined, async () => ({
      code: 5,
      stdout: "",
      stderr: "no passphrase captured",
    })),
  ).rejects.toThrow("did not succeed");
  await expect(
    recoverWechatPassphrase({ driverDir: "/private/capture" }, undefined, async () => ({
      code: 0,
      stdout: "nothing useful here",
      stderr: "",
    })),
  ).rejects.toThrow("no passphrase");
});
