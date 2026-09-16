// WeChat user-account (personal) transport. Channel contract: docs/architecture/channels.md.
//
// Unlike the ilink bot channel (packages/core/src/channels/wechat.ts), this
// reads the guardian's own account. The official desktop client runs in this
// container, on the desktop Rome already serves at /desktop, and writes its
// message store to this container's filesystem. Reading is therefore local: no
// service to call, no mirror to keep — the client's own SQLite is the store,
// and Rome queries it where it lies.
//
// The client is 744 MB, so it is fetched into a volume when a guardian
// connects rather than baked into the image. Its shared libraries are not:
// those live in the image, because WeChat resolves EGL through glvnd and glvnd
// finds its vendor driver through ldconfig — staging those in a volume and
// pointing LD_LIBRARY_PATH at it leaves eglGetPlatformDisplayEXT unresolved and
// the client dies before it draws anything.
//
// The store is SQLCipher, keyed by a passphrase the client holds only in
// memory. Recovering it needs ptrace on the live client, which this container
// deliberately cannot do; that half runs as root on the hosting VM and is in
// ./wechat-user-keys.ts. Everything here is unprivileged.

import { execFile } from "node:child_process";
import { access, mkdir, readFile, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLogger } from "../logger.js";

const log = createLogger("wechat-user");

/**
 * The pinned client build. WeChat ships no stable download for a given version,
 * so the digest is the pin: the key-recovery step locates its breakpoint by
 * scanning this exact binary, and a silently newer client would move it.
 */
export const WECHAT_CLIENT_URL =
  "https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb";
const WECHAT_CLIENT_SHA256 = "096865e050ba0d3c1a23887227e2400bf343037b1d7d658c84c88ff26bfdc17f";

/**
 * The reader's understanding of WeChat's on-disk formats — SQLCipher page
 * layout, zstd message bodies, the sharded message tables — comes from
 * `wechat-cli`, pinned to a commit. The helper next to this file calls into it
 * rather than shelling out to its command line, which renders every message as
 * a display string and loses the fields a caller wants.
 */
export const WECHAT_CLI_SOURCE =
  "git+https://github.com/huohuoer/wechat-cli@a3789232d4f79bf0b30634d9dadbce71e4acd601";

/** Where the deb is unpacked to, and the path the client insists on being at. */
export const WECHAT_CANONICAL_PREFIX = "/opt/wechat";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Installing downloads and unpacks the better part of a gigabyte. */
const INSTALL_TIMEOUT_MS = 20 * 60_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

/** Injectable process seam: the runtime, the reader and the setup all spawn
 *  through this, so tests never start a process. */
export type RunCommand = (file: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** The production runner. A non-zero exit is not a rejection — callers
 *  classify, and need the captured output either way. */
export const runCommand: RunCommand = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          reject(
            Object.assign(new Error(`${file} could not be run: ${error.message}`), {
              code: (error as NodeJS.ErrnoException).code,
            }),
          );
          return;
        }
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code?: number }).code ?? null)
            : null
          : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

// ── status ────────────────────────────────────────────────────────────────

/**
 * What the client is doing, as a linear progression through connecting. The
 * setup renders each state; nothing else needs to distinguish them.
 *   absent          — the client is not installed in this container yet
 *   installing      — fetching and unpacking it
 *   starting        — launched, not yet drawing
 *   awaiting-scan   — showing a login QR on the desktop
 *   awaiting-keys   — signed in, but the message store is still locked
 *   ready           — signed in with a working key; reads work
 */
export type WechatUserState =
  | "absent"
  | "installing"
  | "starting"
  | "awaiting-scan"
  | "awaiting-keys"
  | "ready";

export interface WechatUserStatus {
  state: WechatUserState;
  installed: boolean;
  running: boolean;
  /** True once the client has written an account store, which it does on login. */
  loggedIn: boolean;
  keysReady: boolean;
  /** The account's own directory name, which is its WeChat id. */
  wxid?: string;
  /** The client's pid in THIS container's namespace. The key-recovery step
   *  translates it, because host root sees a different number. */
  pid?: number;
}

// ── reader shapes ─────────────────────────────────────────────────────────

export const wechatUserConversationSchema = z.object({
  /** WeChat's own chat address — `wxid_…` for a contact, `…@chatroom` for a
   *  group. Stable across renames, which display names are not. */
  id: z.string().min(1),
  name: z.string(),
  isGroup: z.boolean(),
  unread: z.number().int().nonnegative().default(0),
  /** Unix seconds of the newest message. */
  lastMessageAt: z.number().int().nonnegative().nullish(),
  lastMessagePreview: z.string().nullish(),
});
export type WechatUserConversation = z.infer<typeof wechatUserConversationSchema>;

export const wechatUserMessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  conversationName: z.string().optional(),
  isGroup: z.boolean(),
  /** The sender's WeChat id. Empty for a system notice with no author. */
  senderId: z.string(),
  senderName: z.string().optional(),
  isSelf: z.boolean(),
  /** Unix seconds. */
  timestamp: z.number().int().nonnegative(),
  /** A stable token (`text`, `image`, …), never the CLI's localized label. */
  type: z.string(),
  /** Plain-text rendering. A non-text message reads as a short placeholder
   *  rather than empty, because a transcript that drops them silently misreads
   *  the conversation. */
  text: z.string(),
});
export type WechatUserMessage = z.infer<typeof wechatUserMessageSchema>;

const conversationsSchema = z.object({ conversations: z.array(wechatUserConversationSchema) });
const messagesSchema = z.object({ messages: z.array(wechatUserMessageSchema) });
const countSchema = z.object({ count: z.number().int().nonnegative() });

/** The account is not readable: signed out, or a key that no longer fits. Only
 *  a fresh scan fixes it, so the integration maps this to CredentialRejected. */
export class WechatUserSessionRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WechatUserSessionRejected";
  }
}

/** The client or its reader could not be run. Transient by assumption. */
export class WechatUserRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WechatUserRuntimeError";
  }
}

/** The client has not finished creating the message databases after login. */
export class WechatUserStorePending extends WechatUserRuntimeError {}

export function isWechatUserSessionRejected(error: unknown): boolean {
  return error instanceof WechatUserSessionRejected;
}

// ── runtime ───────────────────────────────────────────────────────────────

export interface WechatUserRuntimeConfig {
  /** Volume-backed install prefix. Defaults under the guardian's home so it
   *  survives a container rebuild. */
  prefix?: string;
  /** The container's own home, where the client writes its store. */
  home?: string;
  /** The X display Rome already serves at /desktop. */
  display?: string;
  /** The path the client is exposed at. Defaults to its canonical /opt/wechat;
   *  injectable so tests need no writable /opt. */
  canonicalPrefix?: string;
  run?: RunCommand;
}

/** Resolve the helper that ships next to this module. */
function helperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "wechat-user-helper.py");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Pick the client's visible login window from `xwininfo -root -tree` output.
 *  The login window's title is "Weixin"; the tiny helper windows the client
 *  also maps are titled "wechat", so the exact title is what tells them apart. */
export function loginWindowId(tree: string): string | null {
  const match = /(0x[0-9a-fA-F]+)\s+"Weixin"/.exec(tree);
  return match ? match[1]! : null;
}

/**
 * The WeChat client as this container runs it: install it, start it on Rome's
 * desktop, and answer what it is doing. Everything here is unprivileged — the
 * container needs no added capability, because the one privileged step runs on
 * the hosting VM instead.
 */
export class WechatUserRuntime {
  readonly prefix: string;
  readonly home: string;
  readonly display: string;
  readonly canonicalPrefix: string;
  private readonly run: RunCommand;

  constructor(config: WechatUserRuntimeConfig = {}) {
    this.home = config.home ?? process.env.HOME ?? homedir();
    this.prefix = config.prefix ?? join(this.home, ".local", "share", "wechat");
    this.display = config.display ?? process.env.DISPLAY ?? ":99";
    this.canonicalPrefix = config.canonicalPrefix ?? WECHAT_CANONICAL_PREFIX;
    this.run = config.run ?? runCommand;
  }

  /** Where the unpacked client lives before it is linked to its canonical path. */
  get clientDir(): string {
    return join(this.prefix, "client", "opt", "wechat");
  }

  /** The python environment holding the reader's dependencies. */
  get venvDir(): string {
    return join(this.prefix, "cli");
  }

  get keysFile(): string {
    return join(this.home, ".wechat-cli", "all_keys.json");
  }

  /** The signed-in account's store directory, or null when signed out. */
  async accountDir(): Promise<string | null> {
    const root = join(this.home, "xwechat_files");
    const listed = await this.run("sh", ["-c", `ls -1 ${root} 2>/dev/null`]).catch(() => null);
    const names = (listed?.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("all-user"));
    for (const name of names) {
      if (await exists(join(root, name, "db_storage"))) return join(root, name);
    }
    return null;
  }

  /** The client's pid in this container, or null when it is not running. */
  async pid(): Promise<number | null> {
    const found = await this.run("pgrep", ["-f", `${WECHAT_CANONICAL_PREFIX}/wechat`]).catch(
      () => null,
    );
    const first = (found?.stdout ?? "").split("\n")[0]?.trim();
    const pid = first ? Number(first) : Number.NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  /**
   * Screenshot the client's login window as a PNG `data:` URL, or null when
   * there is no window to capture yet.
   *
   * A fresh login draws its QR in a small top-level window titled "Weixin"; the
   * setup shows that image inline so the guardian scans it with their phone
   * without opening the desktop. (A remembered account draws a sign-in button
   * there instead, which a still image cannot drive — the setup falls back to
   * the desktop link for that.) The capture runs against the container's own
   * display and needs no privilege.
   */
  async captureLoginQr(): Promise<string | null> {
    const env = { DISPLAY: this.display };
    const tree = await this.run("xwininfo", ["-root", "-tree"], { env }).catch(() => null);
    if (!tree || tree.code !== 0) return null;
    const windowId = loginWindowId(tree.stdout);
    if (!windowId) return null;
    // import writes the window's pixels; base64 -w0 keeps it a single line for
    // the data URL. A window that is not yet viewable fails, and we return null.
    const shot = await this.run("sh", ["-c", `import -window ${windowId} png:- | base64 -w0`], {
      env,
    }).catch(() => null);
    const encoded = shot?.stdout.trim();
    if (!shot || shot.code !== 0 || !encoded) return null;
    return `data:image/png;base64,${encoded}`;
  }

  async status(): Promise<WechatUserStatus> {
    const installed = await exists(join(this.clientDir, "wechat"));
    const pid = installed ? await this.pid() : null;
    const account = installed ? await this.accountDir() : null;
    let keysReady = false;
    if (account !== null && (await exists(this.keysFile))) {
      try {
        const checked = z
          .object({ keysReady: z.literal(true) })
          .parse(await this.readerCommand(["check"]));
        keysReady = checked.keysReady;
      } catch (error) {
        if (!isWechatUserSessionRejected(error) && !(error instanceof WechatUserStorePending))
          throw error;
      }
    }

    let state: WechatUserState;
    if (!installed) state = "absent";
    else if (keysReady) state = "ready";
    else if (account) state = "awaiting-keys";
    else if (pid) state = "awaiting-scan";
    else state = "starting";

    return {
      state,
      installed,
      running: pid !== null,
      loggedIn: account !== null,
      keysReady,
      ...(account ? { wxid: account.split("/").pop() ?? undefined } : {}),
      ...(pid ? { pid } : {}),
    };
  }

  /**
   * Fetch and unpack the client, then expose it at its canonical path.
   *
   * The deb is unpacked rather than installed: `dpkg -i` would write into /usr,
   * which no volume backs, so a container rebuild would silently lose the
   * client while its data survived. The symlink exists because the client
   * resolves its own resources against `/opt/wechat` regardless of where it
   * was started from.
   */
  async install(signal?: AbortSignal): Promise<void> {
    const deb = join(this.prefix, "wechat.deb");
    const clientRoot = join(this.prefix, "client");
    await mkdir(this.prefix, { recursive: true });

    if (!(await exists(deb))) {
      log.info("wechat_user.downloading_client", { url: WECHAT_CLIENT_URL });
      const downloaded = await this.run(
        "curl",
        ["-fsSL", "--retry", "3", "-o", `${deb}.part`, WECHAT_CLIENT_URL],
        { timeoutMs: INSTALL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      if (downloaded.code !== 0) {
        throw new WechatUserRuntimeError(
          `Could not download the WeChat client: ${downloaded.stderr.trim() || "curl failed"}`,
        );
      }
      await this.run("mv", [`${deb}.part`, deb]);
    }

    if (!(await exists(join(this.clientDir, "wechat")))) {
      const checksum = await this.run("sha256sum", [deb], {
        ...(signal ? { signal } : {}),
      });
      if (checksum.code !== 0 || checksum.stdout.trim().split(/\s+/)[0] !== WECHAT_CLIENT_SHA256) {
        throw new WechatUserRuntimeError(
          "The WeChat client checksum does not match the supported 4.1.13.9 build. " +
            "Install the supported archive or update Rome before connecting.",
        );
      }
      log.info("wechat_user.unpacking_client", { prefix: clientRoot });
      await mkdir(clientRoot, { recursive: true });
      const unpacked = await this.run("dpkg-deb", ["-x", deb, clientRoot], {
        timeoutMs: INSTALL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      if (unpacked.code !== 0) {
        throw new WechatUserRuntimeError(
          `Could not unpack the WeChat client: ${unpacked.stderr.trim() || "dpkg-deb failed"}`,
        );
      }
    }

    if (!(await exists(this.canonicalPrefix))) {
      await symlink(this.clientDir, this.canonicalPrefix).catch((error: unknown) => {
        throw new WechatUserRuntimeError(
          `Could not link ${this.canonicalPrefix}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  /** The environment the client needs. Established empirically; the client
   *  faults or draws nothing without these. */
  private clientEnv(): Record<string, string> {
    return {
      DISPLAY: this.display,
      HOME: this.home,
      QT_QPA_PLATFORM: "xcb",
      LIBGL_ALWAYS_SOFTWARE: "1",
      XDG_RUNTIME_DIR: "/run/user/0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
    };
  }

  /**
   * Bring up the desktop session the client draws into — the XDG runtime dir and
   * a session bus — without launching the client. Idempotent.
   *
   * Key recovery does not start the client the ordinary way; it launches it under
   * gdb from the hosting VM. That launched client still needs a session bus in
   * this container (without one it starts and then stalls before drawing), so the
   * setup calls this first and the client the VM launches finds the bus already
   * up.
   */
  async prepareSession(): Promise<void> {
    await mkdir("/run/user/0", { recursive: true, mode: 0o700 }).catch(() => {});
    await this.run("sh", [
      "-c",
      "pgrep -f 'dbus-daemon --session' >/dev/null || " +
        "dbus-daemon --session --fork --address=unix:path=/run/user/0/bus >/dev/null 2>&1 || true",
    ]).catch(() => {});
  }

  /** Start the client the ordinary way if it is not already running. Idempotent.
   *  The connection setup does not use this — it launches the client under gdb
   *  to catch the first login's key — but it is kept for running the client
   *  outside a key recovery. */
  async start(signal?: AbortSignal): Promise<void> {
    if (await this.pid()) return;
    await this.prepareSession();

    const started = await this.run(
      "sh",
      [
        "-c",
        `cd ${this.canonicalPrefix} && setsid ./wechat >${join(this.prefix, "client.log")} 2>&1 &`,
      ],
      { env: this.clientEnv(), ...(signal ? { signal } : {}) },
    );
    if (started.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not start the WeChat client: ${started.stderr.trim() || "spawn failed"}`,
      );
    }
    log.info("wechat_user.client_started", { display: this.display });
  }

  async stop(): Promise<void> {
    await this.run("pkill", ["-f", `${this.canonicalPrefix}/wechat`]).catch(() => {});
  }

  /** Install the reader's python dependencies into the volume. */
  async installReader(signal?: AbortSignal): Promise<void> {
    if (await exists(join(this.venvDir, "bin", "python3"))) return;
    const created = await this.run("python3", ["-m", "venv", this.venvDir], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    if (created.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not create the reader environment: ${created.stderr.trim()}`,
      );
    }
    const installed = await this.run(
      join(this.venvDir, "bin", "pip"),
      ["install", "--quiet", WECHAT_CLI_SOURCE],
      { timeoutMs: INSTALL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    if (installed.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not install the reader's dependencies: ${installed.stderr.trim()}`,
      );
    }
  }

  /**
   * Run the reader helper. The helper owns everything that needs WeChat's own
   * file formats — SQLCipher page decryption, zstd message bodies, the rich
   * message envelopes — and answers plain JSON.
   */
  async readerCommand(args: string[], signal?: AbortSignal): Promise<unknown> {
    const result = await this.run(join(this.venvDir, "bin", "python3"), [helperPath(), ...args], {
      env: { HOME: this.home },
      timeoutMs: 5 * 60_000,
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new WechatUserSessionRejected("The WeChat reader has not been installed yet.");
      }
      throw error;
    });
    if (result.code === 3) {
      throw new WechatUserSessionRejected(
        result.stderr.trim() || "The WeChat account is signed out, or its key no longer fits.",
      );
    }
    if (result.code === 4) {
      throw new WechatUserStorePending(
        result.stderr.trim() || "The WeChat store is not ready yet.",
      );
    }
    if (result.code !== 0) {
      throw new WechatUserRuntimeError(
        `The WeChat reader failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new WechatUserRuntimeError(
        `The WeChat reader returned unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// ── reader ────────────────────────────────────────────────────────────────

/** Reads the signed-in account's own store. Every call is a live query: the
 *  client's SQLite is the record, so a Rome-side copy would only add staleness. */
export class WechatUserReader {
  constructor(private readonly runtime: WechatUserRuntime) {}

  async conversations(
    input: { query?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<WechatUserConversation[]> {
    const args = ["conversations", "--limit", String(input.limit)];
    if (input.query) args.push("--query", input.query);
    return conversationsSchema.parse(await this.runtime.readerCommand(args, signal)).conversations;
  }

  async messages(
    input: {
      conversationId?: string;
      since?: Date;
      before?: Date;
      limit: number;
      includeBoundaryTies?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<WechatUserMessage[]> {
    const args = ["messages", "--limit", String(input.limit)];
    if (input.includeBoundaryTies) args.push("--include-boundary-ties");
    if (input.conversationId) args.push("--conversation", input.conversationId);
    if (input.since) args.push("--since", String(Math.floor(input.since.getTime() / 1000)));
    if (input.before) args.push("--before", String(Math.floor(input.before.getTime() / 1000)));
    return messagesSchema.parse(await this.runtime.readerCommand(args, signal)).messages;
  }

  /** Total messages, including placeholders for undecodable bodies. */
  async count(conversationId: string, signal?: AbortSignal): Promise<number> {
    const parsed = countSchema.parse(
      await this.runtime.readerCommand(["count", "--conversation", conversationId], signal),
    );
    return parsed.count;
  }
}

/** Read the helper source, so callers that stage it elsewhere (the root script)
 *  do not each re-derive where it lives. */
export function readHelperSource(): Promise<string> {
  return readFile(helperPath(), "utf8");
}
