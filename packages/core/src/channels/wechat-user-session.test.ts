import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@rstest/core";
import { runCommand, WechatUserRuntime } from "./wechat-user.js";

it("ignores other process command lines that mention a session bus", async () => {
  const home = await mkdtemp(join(tmpdir(), "wechat-session-"));
  const marker = join(home, "bus-started");
  const daemon = join(home, "dbus-daemon");
  const decoy = spawn(
    process.execPath,
    ["-e", 'process.send("ready"); setInterval(() => {}, 30000)', "dbus-daemon --session"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  try {
    await once(decoy, "message");
    await writeFile(daemon, '#!/bin/sh\nprintf started > "$WECHAT_TEST_BUS"\n');
    await chmod(daemon, 0o700);
    const runtime = new WechatUserRuntime({
      home,
      run: (file, args, options) =>
        runCommand(file, args, {
          ...options,
          env: {
            ...options?.env,
            PATH: `${home}:${process.env.PATH}`,
            WECHAT_TEST_BUS: marker,
          },
        }),
    });
    await runtime.prepareSession();
    expect(await readFile(marker, "utf8")).toBe("started");
  } finally {
    const exited = once(decoy, "exit");
    decoy.kill();
    await exited;
    await rm(home, { recursive: true, force: true });
  }
});
