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
it("requires both the PID and namespace identity before entering a container", async () => {
  let script = "";
  const result = await recoverWechatPassphrase(
    {
      run: async (request) => {
        script = request.script;
        return {
          status: "succeeded",
          exitCode: 0,
          stdout: `PASSPHRASE ${"ab".repeat(32)}`,
          stderr: "",
          truncated: false,
          jobId: "test",
        };
      },
    },
    {
      anchorPid: 123,
      pidNamespace: "pid:[456]",
      driverDir: "/private/capture",
      home: "/home/rome",
    },
  );
  expect(result).toBe("ab".repeat(32));
  expect(script).toContain("pid_namespace='pid:[456]'");
  expect(script).toContain('[ "$ns" = "$anchor" ] && [ "$(readlink "$candidate/ns/pid"');
});
