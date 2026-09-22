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

import { existsSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  loginWindowId,
  WechatUserReader,
  WechatUserRuntime,
  WechatUserRuntimeError,
  WechatUserSessionRejected,
  WECHAT_CLIENT_SHA256,
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
