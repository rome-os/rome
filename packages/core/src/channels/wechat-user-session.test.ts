import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    await writeFile(
      daemon,
      '#!/bin/sh\nprintf \'%s\\n\' "$XDG_RUNTIME_DIR|$DBUS_SESSION_BUS_ADDRESS|$DISPLAY" > "$WECHAT_TEST_BUS"\n',
    );
    await chmod(daemon, 0o700);
    const runtime = new WechatUserRuntime({
      home,
      display: ":88",
      runtimeDir: join(home, "run"),
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
    expect(await readFile(marker, "utf8")).toBe(
      `${runtime.runtimeDir}|unix:path=${runtime.runtimeDir}/bus|:88\n`,
    );
    expect((await stat(runtime.runtimeDir)).mode & 0o777).toBe(0o700);
  } finally {
    const exited = once(decoy, "exit");
    decoy.kill();
    await exited;
    await rm(home, { recursive: true, force: true });
  }
});

it("reuses its own session socket and reports bus startup failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "wechat-session-"));
  const server = createServer();
  try {
    server.listen(join(home, "bus"));
    await once(server, "listening");
    const runtime = new WechatUserRuntime({ runtimeDir: home });
    await runtime.prepareSession();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const failed = new WechatUserRuntime({
      runtimeDir: home,
      run: async () => ({ code: 1, stdout: "", stderr: "permission denied" }),
    });
    await expect(failed.prepareSession()).rejects.toThrow("permission denied");
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
