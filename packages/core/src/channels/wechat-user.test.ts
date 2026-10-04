// The WeChat user-account runtime and reader, driven against an injected
// command runner (no client, no bridge process, no filesystem side effects
// beyond a temp home).
//
// Seams under test:
//   1. status() reads the linear connecting progression off the filesystem and
//      the process table.
//   2. install() unpacks rather than dpkg-installs, and is idempotent.
//   3. The reader maps wechat-cli's JSON envelopes onto its own shapes, and
//      classifies missing keys as terminal and everything else as transient.

import { existsSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  loginWindowId,
  WechatUserReader,
  WechatUserRuntime,
  WechatUserRuntimeError,
  WechatUserSessionRejected,
  WechatUserStorePending,
  WECHAT_CLIENT_SHA256,
  type RunCommand,
  type RunResult,
} from "./wechat-user.js";
import { writeStore } from "./wechat-user-store-fixture.js";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A runner that answers per command, matched by the file and first arg. */
function scriptedRun(handlers: Record<string, (args: string[]) => RunResult>): {
  run: RunCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: RunCommand = async (file, args) => {
    calls.push([file, ...args]);
    const key = `${file} ${args[0] ?? ""}`.trim();
    const handler = handlers[key] ?? handlers[file];
    return handler ? handler(args) : ok();
  };
  return { run, calls };
}

let home: string;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
});

async function tempHome(): Promise<string> {
  home = await mkdtemp(join(tmpdir(), "wechat-user-"));
  return home;
}

/** An account store under `h` whose stored keys open it, as a capture leaves
 *  it. With `stale`, the stored keys no longer fit the store. */
async function readableStore(h: string, runtime: WechatUserRuntime, stale = false): Promise<void> {
  const dbDir = join(h, "xwechat_files/wxid_guardian/db_storage");
  const salt = randomBytes(16);
  const keys = await writeStore(dbDir, randomBytes(32), salt);
  if (stale) await writeStore(dbDir, randomBytes(32), salt, ["message/message_0.db"]);
  await writeFile(
    await ensureFile(runtime.keysFile),
    JSON.stringify({ dbDir, wxid: "wxid_guardian", keys, capturedAt: "2026-10-04T00:00:00Z" }),
  );
}

const LOGIN_HINTS =
  "\nProgram supplied minimum size: 280 by 380\nProgram supplied maximum size: 280 by 380";

describe("loginWindowId", () => {
  it("skips a same-title chat window before the pinned login window", () => {
    expect(
      loginWindowId(
        '0x1 "Weixin": ("wechat" "wechat") 900x700+0+0\n0x2 "Weixin": ("wechat" "wechat") 280x380+0+0',
      ),
    ).toBe("0x2");
  });
});

describe("WechatUserRuntime.status", () => {
  it("reads absent before the client is installed", async () => {
    const runtime = new WechatUserRuntime({ home: await tempHome(), run: scriptedRun({}).run });
    expect((await runtime.status()).state).toBe("absent");
  });

  it("reads awaiting-scan once installed and running but signed out", async () => {
    const h = await tempHome();
    const runtime = new WechatUserRuntime({
      home: h,
      run: scriptedRun({
        pgrep: () => ok("1234\n"),
        xwininfo: (args) =>
          ok(
            args[0] === "-id"
              ? `Map State: IsViewable${LOGIN_HINTS}`
              : '0x123 "Weixin": ("wechat" "wechat") 280x380+0+0',
          ),
      }).run,
    });
    await mkdir(join(h, ".local", "share", "wechat", "client", "opt", "wechat"), {
      recursive: true,
    });
    await writeFile(join(h, ".local", "share", "wechat", "client", "opt", "wechat", "wechat"), "x");

    const status = await runtime.status();
    expect(status.state).toBe("awaiting-scan");
    expect(status.running).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.pid).toBe(1234);
  });

  it.each([
    "login",
    "hidden",
    "main",
    "vanished",
  ])("distinguishes cached keys from a visible login prompt (%s)", async (kind) => {
    const h = await tempHome();
    const runtime = new WechatUserRuntime({
      home: h,
      run: scriptedRun({
        pgrep: () => ok("1234\n"),
        xwininfo: (args) => {
          if (args[0] !== "-id") return ok('0x123 "Weixin": ("wechat" "wechat") 280x380+0+0');
          if (kind === "vanished") return { code: 1, stdout: "", stderr: "BadWindow" };
          return ok(
            kind === "hidden"
              ? `Map State: IsUnMapped${LOGIN_HINTS}`
              : `Map State: IsViewable${kind === "main" ? "" : LOGIN_HINTS}`,
          );
        },
        // accountDir lists xwechat_files
        sh: (args) => (args[1]?.includes("xwechat_files") ? ok("wxid_guardian\n") : ok()),
      }).run,
    });
    await writeFile(await ensureFile(join(h, ".local/share/wechat/client/opt/wechat/wechat")), "x");
    await readableStore(h, runtime);

    const status = await runtime.status();
    expect(status.state).toBe(kind === "login" ? "awaiting-scan" : "ready");
    expect(status.loggedIn).toBe(true);
    expect(status.keysReady).toBe(true);
    expect(status.wxid).toBe("wxid_guardian");
  });

  it("keeps readable cached history separate from a stopped client", async () => {
    const h = await tempHome();
    const runtime = new WechatUserRuntime({
      home: h,
      run: scriptedRun({
        pgrep: () => ({ code: 1, stdout: "", stderr: "" }),
        sh: () => ok("wxid_guardian\n"),
      }).run,
    });
    await writeFile(await ensureFile(join(runtime.clientDir, "wechat")), "x");
    await readableStore(h, runtime);
    expect(await runtime.status()).toMatchObject({
      state: "stopped",
      running: false,
      loggedIn: true,
      keysReady: true,
    });
  });

  it.each(["missing", "stale"])("keeps %s keys awaiting keys", async (kind) => {
    const h = await tempHome();
    const runtime = new WechatUserRuntime({
      home: h,
      run: scriptedRun({
        pgrep: () => ok("1234\n"),
        sh: () => ok("wxid_guardian\n"),
      }).run,
    });
    await writeFile(await ensureFile(join(h, ".local/share/wechat/client/opt/wechat/wechat")), "x");
    if (kind === "stale") await readableStore(h, runtime, true);
    else await ensureDir(join(h, "xwechat_files/wxid_guardian/db_storage"));
    expect(await runtime.status()).toMatchObject({ state: "awaiting-keys", keysReady: false });
  });
});

describe("WechatUserRuntime.start", () => {
  it("restores the client link and coalesces concurrent launches without installing", async () => {
    const h = await tempHome();
    const { run, calls } = scriptedRun({});
    const runtime = new WechatUserRuntime({
      home: h,
      runtimeDir: join(h, "run"),
      canonicalPrefix: join(h, "opt-wechat"),
      run,
    });
    await writeFile(await ensureFile(join(runtime.clientDir, "wechat")), "x");
    await Promise.all([runtime.start(), runtime.start()]);
    expect(await readlink(runtime.canonicalPrefix)).toBe(runtime.clientDir);
    expect(
      calls.filter((call) => call.some((arg) => arg.includes('setsid "$1/wechat"'))),
    ).toHaveLength(1);
    expect(calls).toContainEqual(["pgrep", "-x", "wechat"]);
    expect(calls.some((call) => ["curl", "dpkg-deb", "pkill"].includes(call[0]!))).toBe(false);
  });

  it("launches nothing while a key capture holds the client", async () => {
    const h = await tempHome();
    const { run, calls } = scriptedRun({});
    const runtime = new WechatUserRuntime({
      home: h,
      runtimeDir: join(h, "run"),
      canonicalPrefix: join(h, "opt-wechat"),
      run,
    });
    await writeFile(await ensureFile(join(runtime.clientDir, "wechat")), "x");

    const release = runtime.holdCapture();
    await runtime.start();
    expect(calls.some((call) => call.some((arg) => arg.includes('setsid "$1/wechat"')))).toBe(
      false,
    );

    release();
    release();
    expect(runtime.captureInProgress).toBe(false);
    await runtime.start();
    expect(
      calls.filter((call) => call.some((arg) => arg.includes('setsid "$1/wechat"'))),
    ).toHaveLength(1);
  });

  it("launches nothing when a key capture takes the lease while a start is under way", async () => {
    const h = await tempHome();
    let reachedSession = false;
    let openSession: () => void = () => {};
    const sessionOpen = new Promise<void>((resolve) => {
      openSession = resolve;
    });
    const scripted = scriptedRun({});
    const run: RunCommand = async (file, args, options) => {
      // prepareSession() is one of the slow steps before the launch.
      if (args.includes("wechat-session")) {
        reachedSession = true;
        await sessionOpen;
      }
      return scripted.run(file, args, options);
    };
    const runtime = new WechatUserRuntime({
      home: h,
      runtimeDir: join(h, "run"),
      canonicalPrefix: join(h, "opt-wechat"),
      run,
    });
    await writeFile(await ensureFile(join(runtime.clientDir, "wechat")), "x");

    const starting = runtime.start();
    await rs.waitFor(() => expect(reachedSession).toBe(true));
    const release = runtime.holdCapture();
    openSession();
    await starting;

    expect(
      scripted.calls.some((call) => call.some((arg) => arg.includes('setsid "$1/wechat"'))),
    ).toBe(false);
    release();
  });

  it("leaves an existing desktop process alone", async () => {
    const { run, calls } = scriptedRun({ pgrep: () => ok("42\n") });
    const runtime = new WechatUserRuntime({ home: await tempHome(), run });
    await runtime.start();
    expect(calls).toEqual([["pgrep", "-x", "wechat"]]);
  });
});

describe("WechatUserRuntime display", () => {
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  function wechatEnabled(display = "") {
    rs.stubEnv("WECHAT_USER_ENABLED", "true");
    rs.stubEnv("DISPLAY", ":99");
    rs.stubEnv("WECHAT_USER_DISPLAY", display);
  }

  it("runs on WeChat's own desktop whenever WeChat is enabled", () => {
    wechatEnabled();
    const runtime = new WechatUserRuntime();
    expect(runtime.display).toBe(":100");
    expect(runtime.desktopPathFor(runtime.display)).toBe("/desktop/wechat");
    wechatEnabled(":120");
    expect(new WechatUserRuntime().display).toBe(":120");
    const fixed = new WechatUserRuntime({ display: ":7" });
    expect([fixed.display, fixed.desktopPathFor(fixed.display)]).toEqual([":7", "/desktop"]);
  });

  it("stays on the shared desktop while WeChat is disabled", () => {
    rs.stubEnv("WECHAT_USER_ENABLED", "false");
    rs.stubEnv("DISPLAY", ":99");
    rs.stubEnv("WECHAT_USER_DISPLAY", ":100");
    const runtime = new WechatUserRuntime();
    expect([runtime.display, runtime.desktopPathFor(runtime.display)]).toEqual([":99", "/desktop"]);
  });

  async function installedRuntime(
    run: RunCommand,
    extra: { procDir?: string; desktopScript?: string } = {},
  ) {
    const h = await tempHome();
    const desktopScript = join(h, "rome-start-desktop.sh");
    await writeFile(desktopScript, "#!/bin/bash\n");
    const runtime = new WechatUserRuntime({
      home: h,
      runtimeDir: join(h, "run"),
      canonicalPrefix: join(h, "opt-wechat"),
      run,
      desktopScript,
      ...extra,
    });
    await writeFile(await ensureFile(join(runtime.clientDir, "wechat")), "x");
    return runtime;
  }

  it("starts its desktop with the table's arguments before it starts the client", async () => {
    wechatEnabled(":120");
    rs.stubEnv("ROME_WECHAT_VNC_PORT", "5950");
    rs.stubEnv("ROME_WECHAT_NOVNC_PORT", "6150");
    const calls: Array<{ cmd: string[]; display?: string }> = [];
    const runtime = await installedRuntime(async (file, args, opts) => {
      calls.push({ cmd: [file, ...args], display: opts?.env?.DISPLAY });
      return file === "pgrep" ? { code: 1, stdout: "", stderr: "" } : ok();
    });

    await runtime.start();

    const desktop = calls.findIndex(({ cmd }) => cmd[0] === "env");
    const client = calls.findIndex(({ cmd }) => cmd[0] === "sh" && cmd[2]?.includes("wechat"));
    expect(desktop).toBeGreaterThanOrEqual(0);
    expect(desktop).toBeLessThan(client);
    const cmd = calls[desktop]!.cmd;
    expect(cmd[1]).toBe("-i");
    // Only the runtime's own lock wait; none of Rome's configuration leaks.
    expect(
      cmd.filter(
        (arg) => /^(ROME_|WECHAT_)/.test(arg) && !arg.startsWith("ROME_DESKTOP_LOCK_WAIT="),
      ),
    ).toEqual([]);
    expect(cmd.slice(cmd.indexOf("bash"))).toEqual([
      "bash",
      join(home, "rome-start-desktop.sh"),
      "wechat",
      ":120",
      "5950",
      "6150",
      "/opt/rome/scripts/docker/wechat-openbox-rc.xml",
    ]);
    expect(calls[client]!.display).toBe(":120");
  });

  it("keeps a running client on the display it runs on", async () => {
    wechatEnabled();
    const proc = join(await mkdtemp(join(tmpdir(), "wechat-proc-")), "proc");
    await mkdir(join(proc, "42"), { recursive: true });
    await writeFile(join(proc, "42", "environ"), "HOME=/home/rome\0DISPLAY=:99\0");
    const { run, calls } = scriptedRun({ pgrep: () => ok("42\n") });
    const runtime = await installedRuntime(run, { procDir: proc });

    await runtime.start();
    const status = await runtime.status();

    expect(calls.some(([file]) => file === "env")).toBe(false);
    expect([status.display, status.desktopPath]).toEqual([":99", "/desktop"]);
    await rm(join(proc, ".."), { recursive: true, force: true });
  });

  it("reports a legacy client's display without moving where others look", async () => {
    // status() runs from the probe, the setup and readers at once. A legacy
    // client it finds must not move the QR capture or new starts off :100.
    wechatEnabled();
    const proc = join(await mkdtemp(join(tmpdir(), "wechat-proc-")), "proc");
    await mkdir(join(proc, "42"), { recursive: true });
    await writeFile(join(proc, "42", "environ"), "DISPLAY=:99\0");
    const displays: Array<string | undefined> = [];
    const runtime = await installedRuntime(
      async (file, _args, opts) => {
        if (file === "pgrep") return ok("42\n");
        if (file === "xwininfo") displays.push(opts?.env?.DISPLAY);
        return ok();
      },
      { procDir: proc },
    );

    expect((await runtime.status()).display).toBe(":99");
    expect(displays).toEqual([":99"]);
    await runtime.captureLoginQr();

    expect(runtime.display).toBe(":100");
    expect(displays).toEqual([":99", ":100"]);
    await rm(join(proc, ".."), { recursive: true, force: true });
  });

  it("keeps a running client's display when a repair finds no start script", async () => {
    wechatEnabled();
    const proc = join(await mkdtemp(join(tmpdir(), "wechat-proc-")), "proc");
    await mkdir(join(proc, "42"), { recursive: true });
    await writeFile(join(proc, "42", "environ"), "DISPLAY=:100\0");
    const { run } = scriptedRun({ pgrep: () => ok("42\n") });
    const runtime = await installedRuntime(run, {
      procDir: proc,
      desktopScript: "/nonexistent/start.sh",
    });

    await runtime.repairDesktop();

    expect(runtime.display).toBe(":100");
    expect((await runtime.status()).desktopPath).toBe("/desktop/wechat");
    await rm(join(proc, ".."), { recursive: true, force: true });
  });

  it("returns the display it prepared, for the caller to launch on", async () => {
    wechatEnabled();
    const { run } = scriptedRun({ pgrep: () => ({ code: 1, stdout: "", stderr: "" }) });
    expect(await (await installedRuntime(run)).ensureDesktop()).toBe(":100");
    const missing = await installedRuntime(run, { desktopScript: "/nonexistent/start.sh" });
    expect(await missing.ensureDesktop()).toBe(":99");
  });

  it("stays on the shared desktop where the start script is not installed", async () => {
    wechatEnabled();
    const { run, calls } = scriptedRun({ pgrep: () => ({ code: 1, stdout: "", stderr: "" }) });
    const displays: Array<string | undefined> = [];
    const recording: RunCommand = async (file, args, opts) => {
      if (file === "sh" && args[1]?.includes("wechat")) displays.push(opts?.env?.DISPLAY);
      return run(file, args, opts);
    };
    const onShared = await installedRuntime(recording, { desktopScript: "/nonexistent/start.sh" });

    await onShared.start();

    expect(calls.some(([file]) => file === "env")).toBe(false);
    expect(displays).toEqual([":99"]);
  });

  it("lets the script's own lock error arrive before the runtime's timeout", async () => {
    // A run that waits out a busy lock must fail with the script's message,
    // not be killed first and reported as "exit null".
    wechatEnabled();
    const seen: Array<{ args: string[]; timeoutMs?: number }> = [];
    const runtime = await installedRuntime(async (file, args, opts) => {
      if (file === "env") seen.push({ args, timeoutMs: opts?.timeoutMs });
      return file === "pgrep" ? { code: 1, stdout: "", stderr: "" } : ok();
    });

    await runtime.ensureDesktop();

    const wait = seen[0]!.args.find((arg) => arg.startsWith("ROME_DESKTOP_LOCK_WAIT="));
    expect(wait).toBeDefined();
    const lockWaitS = Number(wait!.split("=")[1]);
    // The script then waits up to 30 s for each of two ports and 5 s for Openbox.
    expect(seen[0]!.timeoutMs).toBeGreaterThan((lockWaitS + 30 + 30 + 5) * 1000);
  });

  it("links a stopped client to the shared desktop where the start script is missing", async () => {
    wechatEnabled();
    const { run } = scriptedRun({ pgrep: () => ({ code: 1, stdout: "", stderr: "" }) });
    const runtime = await installedRuntime(run, { desktopScript: "/nonexistent/start.sh" });

    const status = await runtime.status();

    expect([status.display, status.desktopPath]).toEqual([":99", "/desktop"]);
  });

  it("flags a client still on the shared display as waiting to move", async () => {
    wechatEnabled();
    const proc = join(await mkdtemp(join(tmpdir(), "wechat-proc-")), "proc");
    await mkdir(join(proc, "42"), { recursive: true });
    const { run } = scriptedRun({ pgrep: () => ok("42\n") });
    const runtime = await installedRuntime(run, { procDir: proc });

    await writeFile(join(proc, "42", "environ"), "DISPLAY=:99\0");
    expect((await runtime.status()).movePending).toBe(true);
    await writeFile(join(proc, "42", "environ"), "DISPLAY=:100\0");
    expect((await runtime.status()).movePending).toBe(false);
    // Only the shared display is "beside Chrome". A client left on an older
    // own display, after WECHAT_USER_DISPLAY changed, is not flagged.
    await writeFile(join(proc, "42", "environ"), "DISPLAY=:101\0");
    expect((await runtime.status()).movePending).toBe(false);
    // With no start script the shared display is where the client belongs.
    const hosted = await installedRuntime(run, {
      procDir: proc,
      desktopScript: "/nonexistent/start.sh",
    });
    await writeFile(join(proc, "42", "environ"), "DISPLAY=:99\0");
    expect((await hosted.status()).movePending).toBe(false);
    await rm(join(proc, ".."), { recursive: true, force: true });
  });

  it("treats exit 127 from an installed script as a failure, not a missing script", async () => {
    // A command missing inside the script, such as flock, also exits 127.
    wechatEnabled();
    const { run } = scriptedRun({
      pgrep: () => ({ code: 1, stdout: "", stderr: "" }),
      env: () => ({ code: 127, stdout: "", stderr: "flock: command not found" }),
    });
    const runtime = await installedRuntime(run);

    await expect(runtime.start()).rejects.toThrow(
      "Could not start WeChat's desktop: flock: command not found",
    );
    expect(runtime.display).toBe(":100");
  });

  it("gives the script an operator's ROME_DESKTOP_LOG_DIR", async () => {
    wechatEnabled();
    rs.stubEnv("ROME_DESKTOP_LOG_DIR", "/var/log/rome");
    const { run, calls } = scriptedRun({ pgrep: () => ({ code: 1, stdout: "", stderr: "" }) });
    const runtime = await installedRuntime(run);

    await runtime.start();

    expect(calls.find(([file]) => file === "env")).toContain("ROME_DESKTOP_LOG_DIR=/var/log/rome");
  });

  it("repairs the desktop under a running client on it, and never throws", async () => {
    wechatEnabled();
    const proc = join(await mkdtemp(join(tmpdir(), "wechat-proc-")), "proc");
    await mkdir(join(proc, "42"), { recursive: true });
    await writeFile(join(proc, "42", "environ"), "DISPLAY=:100\0");
    let exit = 0;
    const { run, calls } = scriptedRun({
      pgrep: () => ok("42\n"),
      env: () => ({ code: exit, stdout: "", stderr: "Error: websockify exited" }),
    });
    const runtime = await installedRuntime(run, { procDir: proc });

    await runtime.status();
    await runtime.repairDesktop();
    expect(calls.filter(([file]) => file === "env")).toHaveLength(1);
    exit = 1;
    await expect(runtime.repairDesktop()).resolves.toBeUndefined();
    expect(calls.filter(([file]) => file === "env")).toHaveLength(2);
    await rm(join(proc, ".."), { recursive: true, force: true });
  });

  it("leaves a client on another display alone when repairing", async () => {
    wechatEnabled();
    const proc = join(await mkdtemp(join(tmpdir(), "wechat-proc-")), "proc");
    await mkdir(join(proc, "42"), { recursive: true });
    await writeFile(join(proc, "42", "environ"), "DISPLAY=:99\0");
    const { run, calls } = scriptedRun({ pgrep: () => ok("42\n") });
    const runtime = await installedRuntime(run, { procDir: proc });

    await runtime.status();
    await runtime.repairDesktop();

    expect(calls.some(([file]) => file === "env")).toBe(false);
    await rm(join(proc, ".."), { recursive: true, force: true });
  });

  it("does not start the client when its desktop fails to start", async () => {
    wechatEnabled();
    const { run, calls } = scriptedRun({
      pgrep: () => ({ code: 1, stdout: "", stderr: "" }),
      env: () => ({ code: 1, stdout: "", stderr: "Error: TCP port 5901 is already in use" }),
    });
    const runtime = await installedRuntime(run);

    await expect(runtime.start()).rejects.toThrow(
      "Could not start WeChat's desktop: Error: TCP port 5901 is already in use",
    );
    expect(calls.some(([file, , script]) => file === "sh" && script?.includes("wechat"))).toBe(
      false,
    );
  });
});

describe("WechatUserRuntime.captureLoginQr", () => {
  it("screenshots the login window as a PNG data URL", async () => {
    const tree = '  0x1000007 "Weixin": ("wechat" "wechat")  280x380+0+0  +500+210\n';
    const runtime = new WechatUserRuntime({
      home: await tempHome(),
      run: scriptedRun({ xwininfo: () => ok(tree), sh: () => ok("QUJD") }).run,
    });
    expect(await runtime.captureLoginQr()).toBe("data:image/png;base64,QUJD");
  });

  it("returns null when no login window is present", async () => {
    const runtime = new WechatUserRuntime({
      home: await tempHome(),
      run: scriptedRun({ xwininfo: () => ok('0x1 "desktop": ()  100x100+0+0') }).run,
    });
    expect(await runtime.captureLoginQr()).toBeNull();
  });
});

/**
 * `curl` and `mv` that touch the filesystem, so a test can assert what the
 * download left behind rather than only which commands ran. `digests` answers
 * `sha256sum` per file name; anything unnamed hashes to the pinned build.
 */
function scriptedDownload(digests: Record<string, string> = {}) {
  return scriptedRun({
    curl: (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "downloaded bytes");
      return ok();
    },
    mv: (args) => {
      renameSync(args[0]!, args[1]!);
      return ok();
    },
    sha256sum: (args) => {
      const path = args[0]!;
      const name = path.split("/").pop()!;
      return ok(`${digests[name] ?? WECHAT_CLIENT_SHA256}  ${path}`);
    },
  });
}

describe("WechatUserRuntime.install", () => {
  it("re-downloads over a cached archive that is not the supported build", async () => {
    const h = await tempHome();
    const deb = await ensureFile(join(h, ".local/share/wechat/wechat.deb"));
    await writeFile(deb, "different build");
    // The cache is the wrong build; whatever replaces it is the right one.
    const { run, calls } = scriptedDownload({ "wechat.deb": "0".repeat(64) });
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    await runtime.install();

    expect(calls.some((call) => call[0] === "curl")).toBe(true);
    expect(calls.some((call) => call[0] === "dpkg-deb")).toBe(true);
    expect(await readFile(deb, "utf8")).toBe("downloaded bytes");
  });

  it("refuses a downloaded archive that differs from the supported build", async () => {
    const h = await tempHome();
    await mkdir(join(h, ".local/share/wechat"), { recursive: true });
    const { run, calls } = scriptedDownload({ "wechat.deb.part": "0".repeat(64) });
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    await expect(runtime.install()).rejects.toThrow(/not the supported 4\.1\.13\.9 build/);
    expect(calls.some((call) => call[0] === "dpkg-deb")).toBe(false);
  });

  it("leaves no cached archive behind when the download is not the supported build", async () => {
    const h = await tempHome();
    await mkdir(join(h, ".local/share/wechat"), { recursive: true });
    const { run } = scriptedDownload({ "wechat.deb.part": "0".repeat(64) });
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    await expect(runtime.install()).rejects.toThrow(WechatUserRuntimeError);

    // A rejected download that stays on disk would win the cache check forever.
    expect(existsSync(join(h, ".local/share/wechat/wechat.deb"))).toBe(false);
    expect(existsSync(join(h, ".local/share/wechat/wechat.deb.part"))).toBe(false);
  });

  it("shares one download between overlapping installs", async () => {
    // The WeChat app's Install button and the connection's setup each call
    // install(); a second caller joins the first rather than writing the same
    // files from a second download.
    const h = await tempHome();
    await mkdir(join(h, ".local/share/wechat"), { recursive: true });
    const { run, calls } = scriptedDownload();
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    const installs = Promise.all([runtime.install(), runtime.install()]);
    expect(runtime.installInFlight).toBe(true);
    await installs;
    expect(runtime.installInFlight).toBe(false);

    expect(calls.filter((call) => call[0] === "curl")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "dpkg-deb")).toHaveLength(1);
  });

  it("lets each caller stop waiting without cancelling another's install", async () => {
    const h = await tempHome();
    await mkdir(join(h, ".local/share/wechat"), { recursive: true });
    const download = scriptedDownload();
    let finishCurl: () => void = () => {};
    const curlDone = new Promise<void>((resolve) => {
      finishCurl = resolve;
    });
    const run: RunCommand = async (file, args, options) => {
      if (file === "curl") await curlDone;
      return download.run(file, args, options);
    };
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    const setup = new AbortController();
    const first = runtime.install(setup.signal);
    const joined = runtime.install();
    setup.abort(new Error("setup cancelled"));

    await expect(first).rejects.toThrow("setup cancelled");
    finishCurl();
    await joined;
    expect(download.calls.filter((call) => call[0] === "dpkg-deb")).toHaveLength(1);
  });

  it("starts no download for a caller already cancelled", async () => {
    const h = await tempHome();
    await mkdir(join(h, ".local/share/wechat"), { recursive: true });
    const { run, calls } = scriptedDownload();
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    const cancelled = new AbortController();
    cancelled.abort(new Error("setup cancelled"));
    await expect(runtime.install(cancelled.signal)).rejects.toThrow("setup cancelled");

    expect(calls.some((call) => call[0] === "curl")).toBe(false);
    expect(runtime.installInFlight).toBe(false);
  });

  it("keeps a cached archive that is the supported build", async () => {
    const h = await tempHome();
    const deb = await ensureFile(join(h, ".local/share/wechat/wechat.deb"));
    await writeFile(deb, "the supported build");
    const { run, calls } = scriptedDownload();
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    await runtime.install();

    expect(calls.some((call) => call[0] === "curl")).toBe(false);
    expect(await readFile(deb, "utf8")).toBe("the supported build");
  });

  it("touches neither the archive nor the digest once the client is unpacked", async () => {
    const h = await tempHome();
    await writeFile(await ensureFile(join(h, ".local/share/wechat/client/opt/wechat/wechat")), "x");
    await writeFile(join(h, ".local/share/wechat/wechat.deb"), "deb");

    const { run, calls } = scriptedRun({});
    const runtime = new WechatUserRuntime({
      home: h,
      canonicalPrefix: join(h, "opt-wechat"),
      run,
    });
    await runtime.install();

    // install() is idempotent: re-entering it with the client unpacked has
    // nothing to read the archive for, so it neither downloads nor hashes.
    expect(calls.some((c) => c[0] === "curl")).toBe(false);
    expect(calls.some((c) => c[0] === "dpkg-deb")).toBe(false);
    expect(calls.some((c) => c[0] === "sha256sum")).toBe(false);
  });

  it("leaves nothing behind when the replacement is also not the supported build", async () => {
    const h = await tempHome();
    const deb = await ensureFile(join(h, ".local/share/wechat/wechat.deb"));
    await writeFile(deb, "different build");
    // Neither what is cached nor what replaces it is the pinned build.
    const { run } = scriptedDownload({
      "wechat.deb": "0".repeat(64),
      "wechat.deb.part": "1".repeat(64),
    });
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    await expect(runtime.install()).rejects.toThrow(/not the supported 4\.1\.13\.9 build/);

    // A wedged install ends clean rather than holding a second archive it
    // would reject just as permanently.
    expect(existsSync(deb)).toBe(false);
    expect(existsSync(`${deb}.part`)).toBe(false);
  });

  it("keeps a cached archive that sha256sum could not read", async () => {
    const h = await tempHome();
    const deb = await ensureFile(join(h, ".local/share/wechat/wechat.deb"));
    await writeFile(deb, "the supported build");
    const { run, calls } = scriptedRun({
      sha256sum: () => ({ code: 1, stdout: "", stderr: "sha256sum: Input/output error" }),
    });
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    await expect(runtime.install()).rejects.toThrow(/Could not checksum/);

    // A digest that never answered is not a digest that failed to match, so the
    // archive survives to be hashed again.
    expect(existsSync(deb)).toBe(true);
    expect(calls.some((c) => c[0] === "curl")).toBe(false);
  });

  it("keeps a cached archive that sha256sum answered for unparseably", async () => {
    const h = await tempHome();
    const deb = await ensureFile(join(h, ".local/share/wechat/wechat.deb"));
    await writeFile(deb, "the supported build");
    // Exit 0, but nothing that can be read as a digest.
    const { run, calls } = scriptedRun({ sha256sum: () => ok("  \n") });
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    await expect(runtime.install()).rejects.toThrow(/Could not checksum/);

    expect(existsSync(deb)).toBe(true);
    expect(calls.some((c) => c[0] === "curl")).toBe(false);
  });

  it("raises a runtime error when the verified archive cannot be stored", async () => {
    const h = await tempHome();
    await mkdir(join(h, ".local/share/wechat"), { recursive: true });
    const { run } = scriptedRun({
      curl: () => ok(),
      sha256sum: (args) => ok(`${WECHAT_CLIENT_SHA256}  ${args[0]}`),
      mv: () => ({ code: 1, stdout: "", stderr: "mv: No space left on device" }),
    });
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });

    await expect(runtime.install()).rejects.toThrow(/Could not store/);
  });

  it("raises a runtime error when the download fails", async () => {
    const h = await tempHome();
    const runtime = new WechatUserRuntime({
      home: h,
      run: scriptedRun({
        curl: () => ({ code: 22, stdout: "", stderr: "404" }),
      }).run,
    });
    await expect(runtime.install()).rejects.toBeInstanceOf(WechatUserRuntimeError);
  });
});

describe("WechatUserReader", () => {
  const envelope = (data: unknown): RunResult => ok(JSON.stringify({ v: 1, ok: true, data }));
  const failure = (code: string): RunResult => ({
    code: 1,
    stdout: JSON.stringify({ v: 1, ok: false, error: { code, message: `${code} happened` } }),
    stderr: "",
  });

  const SESSIONS = [
    {
      username: "45357963768@chatroom",
      displayName: "Karball",
      type: "group",
      unread: 1,
      lastMessage: { content: "wxid_friend:\nsee you", createdAt: "2026-10-01T10:00:00.000Z" },
    },
    {
      username: "wxid_friend",
      displayName: "A Friend",
      type: "private",
      unread: 0,
      lastMessage: { content: "yo", createdAt: "2026-10-01T09:00:00.000Z" },
    },
    { username: "@placeholder_foldgroup", displayName: "折叠的群聊", type: "folded", unread: 0 },
    { username: "wxid_quiet", displayName: "Quiet", type: "private", unread: 0 },
  ];

  function message(id: number, createdAt: string, over: Record<string, unknown> = {}) {
    return {
      id: `wxid_friend:message/message_0.db:${id}`,
      session: "wxid_friend",
      sessionType: "private",
      sender: "wxid_friend",
      senderName: "A Friend",
      isSelf: false,
      type: "text",
      content: `line ${id}`,
      createdAt,
      ...over,
    };
  }

  /** A runtime over an unlocked store whose bridge answers per subcommand.
   *  The calls record each wechat-cli argv after `-f json`. */
  async function readerWith(
    answer: (argv: string[]) => RunResult | Promise<RunResult>,
    store: { stale?: boolean } = {},
  ) {
    const calls: string[][] = [];
    const h = await tempHome();
    const runtime = new WechatUserRuntime({
      home: h,
      run: async (file, args) => {
        if (file === "sh") return ok("wxid_guardian\n");
        expect(file).toBe(process.execPath);
        expect(args.slice(1, 3)).toEqual(["-f", "json"]);
        const argv = args.slice(3);
        calls.push(argv);
        return answer(argv);
      },
    });
    await readableStore(h, runtime, store.stale);
    return { reader: new WechatUserReader(runtime), calls };
  }

  /**
   * A bridge `query` over `history`, paging as wechat-cli does: the newest
   * `-n` messages inside the inclusive `--since`/`--until` seconds, oldest
   * first, with a cursor while older ones remain. Pages larger than
   * `maxPage` overflow the output limit.
   */
  function queryOver(history: ReturnType<typeof message>[], maxPage = Infinity) {
    const second = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const flag = (argv: string[], name: string) =>
      argv.includes(name) ? argv[argv.indexOf(name) + 1]! : undefined;
    return (argv: string[]): RunResult => {
      const limit = Number(flag(argv, "-n"));
      if (limit > maxPage) {
        throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
      }
      const since = flag(argv, "--since");
      const until = flag(argv, "--until");
      const window = history.filter(
        (m) =>
          (!since || second(m.createdAt) >= second(since)) &&
          (!until || second(m.createdAt) <= second(until)),
      );
      const end = Number(flag(argv, "--cursor") ?? window.length);
      const start = Math.max(0, end - limit);
      return envelope({
        messages: window.slice(start, end),
        cursor: start > 0 ? String(start) : null,
      });
    };
  }

  it("lists chats from the session list, without folded entries or empty chats", async () => {
    const { reader, calls } = await readerWith(() => envelope(SESSIONS));
    const conversations = await reader.conversations({ limit: 20 });
    expect(calls).toEqual([["sessions"]]);
    expect(conversations).toEqual([
      {
        id: "45357963768@chatroom",
        name: "Karball",
        isGroup: true,
        unread: 1,
        lastMessageAt: Date.parse("2026-10-01T10:00:00Z") / 1000,
        lastMessagePreview: "see you",
      },
      {
        id: "wxid_friend",
        name: "A Friend",
        isGroup: false,
        unread: 0,
        lastMessageAt: Date.parse("2026-10-01T09:00:00Z") / 1000,
        lastMessagePreview: "yo",
      },
    ]);
  });

  it("reads a preview the client stored as bytes, compressed or not", async () => {
    const asJson = (bytes: Buffer) => JSON.parse(JSON.stringify(new Uint8Array(bytes)));
    const { reader } = await readerWith(() =>
      envelope([
        {
          ...SESSIONS[1],
          lastMessage: { ...SESSIONS[1]!.lastMessage, content: asJson(Buffer.from("plain bytes")) },
        },
        {
          ...SESSIONS[0],
          lastMessage: {
            ...SESSIONS[0]!.lastMessage,
            content: asJson(zstdCompressSync(Buffer.from("wxid_friend:\nsqueezed"))),
          },
        },
      ]),
    );
    const conversations = await reader.conversations({ limit: 5 });
    expect(conversations.map((c) => c.lastMessagePreview)).toEqual(["squeezed", "plain bytes"]);
  });

  it("runs one bridge process at a time", async () => {
    let running = 0;
    let most = 0;
    const query = queryOver([message(1, "2026-10-01T08:00:00.000Z")]);
    const { reader, calls } = await readerWith(async (argv) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return argv[0] === "sessions" ? envelope(SESSIONS) : query(argv);
    });
    // A read across chats asks for several chats at once.
    await reader.messages({ limit: 5 });
    expect(calls.filter((argv) => argv[0] === "query").length).toBeGreaterThan(1);
    expect(most).toBe(1);
  });

  it("picks the most recently active chats, not the pinned ones the bridge lists first", async () => {
    const pinned = {
      username: "wxid_pinned",
      displayName: "Pinned",
      type: "private",
      unread: 0,
      lastMessage: { content: "old news", createdAt: "2026-01-01T00:00:00.000Z" },
    };
    const { reader } = await readerWith(() => envelope([pinned, ...SESSIONS]));
    const conversations = await reader.conversations({ limit: 1 });
    expect(conversations.map((c) => c.id)).toEqual(["45357963768@chatroom"]);
  });

  it("filters chats by name or id", async () => {
    const { reader, calls } = await readerWith(() => envelope(SESSIONS));
    const conversations = await reader.conversations({ query: "friend", limit: 5 });
    expect(calls).toEqual([["sessions"]]);
    expect(conversations.map((c) => c.id)).toEqual(["wxid_friend"]);
  });

  it("reads one chat's window and names it from the session list", async () => {
    const { reader, calls } = await readerWith((argv) =>
      argv[0] === "sessions"
        ? envelope(SESSIONS)
        : envelope({
            messages: [
              message(1, "2026-10-01T08:00:00.000Z"),
              message(2, "2026-10-01T09:00:00.000Z", {
                sender: "wxid_guardian",
                isSelf: true,
                type: "image",
                content: '<?xml version="1.0"?><msg><img aeskey="secret"/></msg>',
              }),
            ],
            cursor: null,
          }),
    );
    const messages = await reader.messages({
      conversationId: "wxid_friend",
      since: new Date("2026-10-01T00:00:00.500Z"),
      before: new Date("2026-10-02T00:00:00Z"),
      limit: 10,
    });
    expect(calls).toContainEqual([
      "query",
      "wxid_friend",
      "-n",
      "10",
      "--since",
      "2026-10-01T00:00:00.000Z",
      "--until",
      "2026-10-02T00:00:00.000Z",
    ]);
    expect(messages).toEqual([
      {
        id: "wxid_friend:message/message_0.db:1",
        conversationId: "wxid_friend",
        conversationName: "A Friend",
        isGroup: false,
        senderId: "wxid_friend",
        senderName: "A Friend",
        isSelf: false,
        timestamp: Date.parse("2026-10-01T08:00:00Z") / 1000,
        type: "text",
        text: "line 1",
      },
      expect.objectContaining({
        senderId: "wxid_guardian",
        isSelf: true,
        type: "image",
        // The envelope is key material, not anything anyone said.
        text: "[image]",
      }),
    ]);
  });

  it("follows the oldest second's ties past the page edge", async () => {
    const edge = "2026-10-01T08:00:00.000Z";
    const query = queryOver([
      message(0, "2026-10-01T07:00:00.000Z"),
      message(1, edge),
      message(2, edge),
      message(3, edge),
      message(4, "2026-10-01T09:00:00.000Z"),
    ]);
    const { reader } = await readerWith((argv) =>
      argv[0] === "sessions" ? envelope(SESSIONS) : query(argv),
    );
    const messages = await reader.messages({
      conversationId: "wxid_friend",
      limit: 2,
      includeBoundaryTies: true,
    });
    expect(messages.map((m) => m.text)).toEqual(["line 1", "line 2", "line 3", "line 4"]);
  });

  it("pages past a cursor second that holds more than a page", async () => {
    const cursorSecond = "2026-10-01T08:00:00.000Z";
    const history = [
      message(0, "2026-10-01T07:59:00.000Z"),
      ...Array.from({ length: 650 }, (_, i) => message(i + 1, cursorSecond)),
      message(651, "2026-10-01T09:00:00.000Z"),
    ];
    const query = queryOver(history);
    const { reader } = await readerWith((argv) =>
      argv[0] === "sessions" ? envelope(SESSIONS) : query(argv),
    );
    const messages = await reader.messages({
      conversationId: "wxid_friend",
      before: new Date(cursorSecond),
      limit: 50,
      includeBoundaryTies: true,
    });
    // The whole cursor second, and the older history behind it.
    expect(messages).toHaveLength(651);
    expect(messages[0]!.text).toBe("line 0");
    expect(messages.at(-1)!.text).toBe("line 650");
  });

  it("reads across the recently active chats when none is named", async () => {
    const { reader, calls } = await readerWith((argv) => {
      if (argv[0] === "sessions") return envelope(SESSIONS);
      return envelope({
        messages: [
          message(
            1,
            argv[1] === "45357963768@chatroom"
              ? "2026-10-01T10:00:00.000Z"
              : "2026-10-01T09:00:00.000Z",
            {
              session: argv[1],
              sessionType: argv[1]!.endsWith("@chatroom") ? "group" : "private",
            },
          ),
        ],
        cursor: null,
      });
    });
    const messages = await reader.messages({ limit: 1 });
    expect(calls).toContainEqual(["sessions"]);
    expect(calls.filter((argv) => argv[0] === "query").map((argv) => argv[1])).toEqual([
      "45357963768@chatroom",
      "wxid_friend",
      "wxid_quiet",
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ conversationId: "45357963768@chatroom", isGroup: true });
  });

  it("counts a chat a page at a time, in smaller pages when a page overflows", async () => {
    const history = Array.from({ length: 2_500 }, (_, i) =>
      message(i, new Date(Date.parse("2026-10-01T00:00:00Z") + i * 1000).toISOString()),
    );
    const { reader, calls } = await readerWith(queryOver(history, 300));
    expect(await reader.count("wxid_friend")).toBe(2_500);
    expect(calls.map((argv) => argv[3])).toContain("250");
  });

  it("reads with the Python reader's keys before any status check migrates them", async () => {
    const h = await tempHome();
    const runtime = new WechatUserRuntime({
      home: h,
      run: async (file) => (file === "sh" ? ok("wxid_guardian\n") : envelope(SESSIONS)),
    });
    await readableStore(h, runtime);
    // Move the keys back to where the Python reader kept them.
    const { dbDir, keys } = JSON.parse(await readFile(runtime.keysFile, "utf8"));
    await rm(runtime.keysFile);
    const legacy = await ensureDir(join(h, ".wechat-cli"));
    await writeFile(join(legacy, "config.json"), JSON.stringify({ db_dir: dbDir }));
    await writeFile(
      join(legacy, "all_keys.json"),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(keys as Record<string, { encKey: string; salt: string }>).map(
            ([rel, k]) => [rel, { enc_key: k.encKey, salt: k.salt, size_mb: 0 }],
          ),
        ),
      ),
    );
    const conversations = await new WechatUserReader(runtime).conversations({ limit: 5 });
    expect(conversations).toHaveLength(2);
    expect(existsSync(runtime.keysFile)).toBe(true);
  });

  it("refuses to read a store whose keys no longer open every database", async () => {
    const { reader, calls } = await readerWith(() => envelope(SESSIONS), { stale: true });
    await expect(reader.conversations({ limit: 5 })).rejects.toBeInstanceOf(
      WechatUserSessionRejected,
    );
    expect(calls).toEqual([]);
  });

  it("reads an unknown chat as empty", async () => {
    const { reader } = await readerWith((argv) =>
      argv[0] === "sessions" ? envelope([]) : failure("SESSION_NOT_FOUND"),
    );
    expect(await reader.messages({ conversationId: "wxid_gone", limit: 5 })).toEqual([]);
    expect(await reader.count("wxid_gone")).toBe(0);
  });

  it.each(["KEY_NOT_FOUND", "WECHAT_NOT_FOUND"])("maps %s to a rejected session", async (code) => {
    const { reader } = await readerWith(() => failure(code));
    await expect(reader.conversations({ limit: 5 })).rejects.toBeInstanceOf(
      WechatUserSessionRejected,
    );
  });

  it("maps a store mid-write to pending, and anything else to a runtime error", async () => {
    await expect(
      (await readerWith(() => failure("DECRYPT_FAILED"))).reader.conversations({ limit: 5 }),
    ).rejects.toBeInstanceOf(WechatUserStorePending);
    const other = (await readerWith(() => failure("DATABASE_QUERY_FAILED"))).reader.conversations({
      limit: 5,
    });
    await expect(other).rejects.toBeInstanceOf(WechatUserRuntimeError);
    await expect(other).rejects.not.toBeInstanceOf(WechatUserSessionRejected);
    await expect(
      (
        await readerWith(() => ({ code: 1, stdout: "", stderr: "node: bad option" }))
      ).reader.conversations({
        limit: 5,
      }),
    ).rejects.toThrow(/bad option/);
  });
});

// ── small fs helpers ────────────────────────────────────────────────────────

async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

async function ensureFile(path: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  return path;
}

// Silence an unused-import lint if rs is not referenced above.
void rs;
