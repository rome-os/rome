// The WeChat user-account runtime and reader, driven against an injected
// command runner (no client, no python, no filesystem side effects beyond a
// temp home).
//
// Seams under test:
//   1. status() reads the linear connecting progression off the filesystem and
//      the process table.
//   2. install() unpacks rather than dpkg-installs, and is idempotent.
//   3. The reader parses the helper's JSON and classifies a signed-out account
//      (exit 3) as terminal, everything else as transient.

import { mkdtemp, mkdir, writeFile, rm, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  loginWindowId,
  WechatUserReader,
  WechatUserRuntime,
  WechatUserRuntimeError,
  WechatUserSessionRejected,
  type RunCommand,
  type RunResult,
} from "./wechat-user.js";

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
        [join(h, ".local/share/wechat/cli/bin/python3")]: () => ok('{"keysReady":true}'),
      }).run,
    });
    await writeFile(await ensureFile(join(h, ".local/share/wechat/client/opt/wechat/wechat")), "x");
    await ensureDir(join(h, "xwechat_files/wxid_guardian/db_storage"));
    await writeFile(await ensureFile(join(h, ".wechat-cli/all_keys.json")), "{}");

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
        [join(h, ".local/share/wechat/cli/bin/python3")]: () => ok('{"keysReady":true}'),
      }).run,
    });
    await writeFile(await ensureFile(join(runtime.clientDir, "wechat")), "x");
    await ensureDir(join(h, "xwechat_files/wxid_guardian/db_storage"));
    await writeFile(await ensureFile(runtime.keysFile), "{}");
    expect(await runtime.status()).toMatchObject({
      state: "stopped",
      running: false,
      loggedIn: true,
      keysReady: true,
    });
  });

  it.each([3, 4])("keeps unreadable or pending keys awaiting keys (exit %s)", async (code) => {
    const h = await tempHome();
    const runtime = new WechatUserRuntime({
      home: h,
      run: scriptedRun({
        pgrep: () => ok("1234\n"),
        sh: () => ok("wxid_guardian\n"),
        [join(h, ".local/share/wechat/cli/bin/python3")]: () => ({
          code,
          stdout: "",
          stderr: "The WeChat message store is locked: message/message_0.db has no valid key.",
        }),
      }).run,
    });
    await writeFile(await ensureFile(join(h, ".local/share/wechat/client/opt/wechat/wechat")), "x");
    await ensureDir(join(h, "xwechat_files/wxid_guardian/db_storage"));
    await writeFile(await ensureFile(join(h, ".wechat-cli/all_keys.json")), "{}");
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
    expect(calls.filter((call) => call.some((arg) => arg.includes("setsid")))).toHaveLength(1);
    expect(calls).toContainEqual(["pgrep", "-x", "wechat"]);
    expect(calls.some((call) => ["curl", "dpkg-deb", "pkill"].includes(call[0]!))).toBe(false);
  });

  it("leaves an existing desktop process alone", async () => {
    const { run, calls } = scriptedRun({ pgrep: () => ok("42\n") });
    const runtime = new WechatUserRuntime({ home: await tempHome(), run });
    await runtime.start();
    expect(calls).toEqual([["pgrep", "-x", "wechat"]]);
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

describe("WechatUserRuntime.install", () => {
  it("refuses a client archive that differs from the supported build", async () => {
    const h = await tempHome();
    await writeFile(await ensureFile(join(h, ".local/share/wechat/wechat.deb")), "different build");
    const { run, calls } = scriptedRun({ sha256sum: () => ok(`${"0".repeat(64)}  wechat.deb`) });
    const runtime = new WechatUserRuntime({ home: h, canonicalPrefix: join(h, "wechat"), run });
    await expect(runtime.install()).rejects.toThrow(/checksum/);
    expect(calls.some((call) => call[0] === "dpkg-deb")).toBe(false);
  });

  it("downloads then unpacks, and unpacking is skipped when already present", async () => {
    const h = await tempHome();
    // Pre-create the unpacked binary so install() only needs the download.
    await writeFile(await ensureFile(join(h, ".local/share/wechat/client/opt/wechat/wechat")), "x");
    await writeFile(join(h, ".local/share/wechat/wechat.deb"), "deb");

    const { run, calls } = scriptedRun({});
    const runtime = new WechatUserRuntime({
      home: h,
      canonicalPrefix: join(h, "opt-wechat"),
      run,
    });
    await runtime.install();

    // Already unpacked and downloaded: no curl, no dpkg-deb.
    expect(calls.some((c) => c[0] === "curl")).toBe(false);
    expect(calls.some((c) => c[0] === "dpkg-deb")).toBe(false);
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
  function readerWith(reader: (args: string[]) => RunResult) {
    const h = "/nonexistent-home";
    const runtime = new WechatUserRuntime({
      home: h,
      run: scriptedRun({
        // readerCommand runs "<venv>/bin/python3 <helper> <subcommand> ..."
        [join(h, ".local/share/wechat/cli/bin/python3")]: reader,
      }).run,
    });
    return new WechatUserReader(runtime);
  }

  it("parses a conversation page", async () => {
    const reader = readerWith(() =>
      ok(
        JSON.stringify({
          conversations: [
            { id: "45357963768@chatroom", name: "Karball", isGroup: true, unread: 1 },
            { id: "wxid_friend", name: "A Friend", isGroup: false, unread: 0 },
          ],
        }),
      ),
    );
    const conversations = await reader.conversations({ limit: 20 });
    expect(conversations).toHaveLength(2);
    expect(conversations[0]!.isGroup).toBe(true);
    expect(conversations[1]!.unread).toBe(0);
  });

  it("maps a signed-out reader (exit 3) to a rejected session", async () => {
    const reader = readerWith(() => ({ code: 3, stdout: "", stderr: "signed out" }));
    await expect(reader.conversations({ limit: 5 })).rejects.toBeInstanceOf(
      WechatUserSessionRejected,
    );
  });

  it("maps any other failure to a runtime error", async () => {
    const reader = readerWith(() => ({ code: 1, stdout: "", stderr: "boom" }));
    await expect(reader.conversations({ limit: 5 })).rejects.toBeInstanceOf(WechatUserRuntimeError);
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
