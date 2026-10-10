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
    // DISPLAY stays off the bus, so nothing it activates can publish to X.
    expect(await readFile(marker, "utf8")).toBe(
      `${runtime.runtimeDir}|unix:path=${runtime.runtimeDir}/bus|\n`,
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

/** Fake `dbus-daemon`, `dbus-send` and AT-SPI launcher on PATH, recording what
 *  the runtime asks of them in `$WECHAT_TEST_STATE`. */
async function accessibilityRig() {
  const home = await mkdtemp(join(tmpdir(), "wechat-a11y-"));
  const state = join(home, "state");
  const scripts: Record<string, string> = {
    "dbus-daemon": "#!/bin/sh\nexit 0\n",
    "dbus-send": `#!/bin/sh
echo "$*" >> "$WECHAT_TEST_STATE.calls"
case "$*" in
  *NameHasOwner*) [ -e "$WECHAT_TEST_STATE.owned" ] && echo "   boolean true" || echo "   boolean false" ;;
  *GetAddress*) echo "   unix:path=$WECHAT_TEST_STATE.a11y" ;;
esac
`,
    launcher: `#!/bin/sh
printf '%s|%s|%s\\n' "$*" "\${DISPLAY-unset}" "$DBUS_SESSION_BUS_ADDRESS" >> "$WECHAT_TEST_STATE.launched"
touch "$WECHAT_TEST_STATE.owned"
`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(join(home, name), body);
    await chmod(join(home, name), 0o700);
  }
  const runtime = (launcher = join(home, "launcher")) =>
    new WechatUserRuntime({
      home,
      display: ":88",
      runtimeDir: join(home, "run"),
      accessibilityLauncher: launcher,
      run: (file, args, options) =>
        runCommand(file, args, {
          ...options,
          env: { ...options?.env, PATH: `${home}:${process.env.PATH}`, WECHAT_TEST_STATE: state },
        }),
    });
  const read = (suffix: string) => readFile(`${state}.${suffix}`, "utf8").catch(() => "");
  return { home, runtime, read };
}

it("starts accessibility on the private session bus once, without the display", async () => {
  const { home, runtime, read } = await accessibilityRig();
  try {
    const wechat = runtime();
    await wechat.prepareSession();
    await wechat.prepareSession();

    expect((await read("launched")).trim().split("\n")).toEqual([
      `--launch-immediately --a11y=1|unset|unix:path=${wechat.runtimeDir}/bus`,
    ]);
    const registryStarts = (await read("calls"))
      .split("\n")
      .filter((call) => call.includes("StartServiceByName"));
    expect(registryStarts).toHaveLength(2);
    expect(registryStarts[0]).toContain(`--bus=unix:path=${home}/state.a11y`);
    expect(registryStarts[0]).toContain("string:org.a11y.atspi.Registry");
    expect(enables(await read("calls"))).toBe(2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("turns accessibility on when another launcher already owns the bus name", async () => {
  const { home, runtime, read } = await accessibilityRig();
  try {
    // Owned by a launcher D-Bus activated on its own, with IsEnabled from GSettings.
    await writeFile(`${home}/state.owned`, "");
    await runtime().prepareSession();
    expect(await read("launched")).toBe("");
    expect(enables(await read("calls"))).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function enables(calls: string): number {
  return calls
    .split("\n")
    .filter((call) => call.includes("Properties.Set") && call.includes("variant:boolean:true"))
    .length;
}

it("keeps the session usable when the image has no accessibility launcher", async () => {
  const { home, runtime, read } = await accessibilityRig();
  try {
    await runtime(join(home, "missing-launcher")).prepareSession();
    expect(await read("launched")).toBe("");
    expect(await read("calls")).toBe("");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
