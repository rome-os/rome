// WeChat user-account (personal) transport. Channel contract: docs/architecture/channels.md.

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
 * Local desktop and store readiness for setup and connection health. A ready
 * client can still be offline. Receipt of a new message proves synchronization.
 *   absent          — the client is not installed in this container yet
 *   installing      — fetching and unpacking it
 *   stopped         — installed, but no desktop client process exists
 *   starting        — launched, not yet drawing
 *   awaiting-scan   — showing a login or confirmation window on the desktop
 *   awaiting-keys   — signed in, but the message store is still locked
 *   ready           — running with a readable store and no visible login prompt
 */
export type WechatUserState =
  | "absent"
  | "installing"
  | "stopped"
  | "starting"
  | "awaiting-scan"
  | "awaiting-keys"
  | "ready";

export interface WechatUserStatus {
  state: WechatUserState;
  installed: boolean;
  running: boolean;
  /** An account store exists. This does not prove the desktop session is signed in. */
  loggedIn: boolean;
  keysReady: boolean;
  /** The account's own directory name, which is its WeChat id. */
  wxid?: string;
  /** The client's pid in THIS container's namespace. The key-recovery step
   *  is used only inside this container. */
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

export function wechatRuntimeDir(): string {
  return join("/run/user", String(process.getuid?.() ?? 0));
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
  /** Private session directory owned by the runtime user. */
  runtimeDir?: string;
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

/** The pinned client's login window is 280×380. A chat window can share its title. */
export function loginWindowId(tree: string): string | null {
  const match = /(0x[0-9a-fA-F]+)\s+"Weixin":\s+\("wechat" "wechat"\)\s+280x380[+-]/.exec(tree);
  return match ? match[1]! : null;
}

export class WechatUserRuntime {
  readonly prefix: string;
  readonly home: string;
  readonly display: string;
  readonly canonicalPrefix: string;
  readonly runtimeDir: string;
  private readonly run: RunCommand;
  private starting: Promise<void> | null = null;

  constructor(config: WechatUserRuntimeConfig = {}) {
    this.home = config.home ?? process.env.HOME ?? homedir();
    this.prefix = config.prefix ?? join(this.home, ".local", "share", "wechat");
    this.display = config.display ?? process.env.DISPLAY ?? ":99";
    this.canonicalPrefix = config.canonicalPrefix ?? WECHAT_CANONICAL_PREFIX;
    this.runtimeDir = config.runtimeDir ?? wechatRuntimeDir();
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

  /** The cached account store directory, or null when no store exists. */
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

  /** This dedicated container owns one WeChat client. Match its process name
   *  because ordinary and debugger launches can use different executable paths. */
  async pid(): Promise<number | null> {
    const found = await this.run("pgrep", ["-x", "wechat"]).catch(() => null);
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

  private async hasLoginWindow(): Promise<boolean> {
    const tree = await this.run("xwininfo", ["-root", "-tree"], {
      env: { DISPLAY: this.display },
    });
    if (tree.code !== 0) {
      throw new WechatUserRuntimeError("Could not inspect the WeChat desktop session.");
    }
    const windowId = loginWindowId(tree.stdout);
    if (!windowId) return false;
    const window = await this.run("xwininfo", ["-id", windowId, "-stats", "-size"], {
      env: { DISPLAY: this.display },
    });
    // Login can destroy the window between the tree snapshot and this lookup.
    if (window.code !== 0) return false;
    return (
      /Map State: IsViewable/.test(window.stdout) &&
      /Program supplied minimum size: 280 by 380/.test(window.stdout) &&
      /Program supplied maximum size: 280 by 380/.test(window.stdout)
    );
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
    else if (!pid) state = "stopped";
    else if (await this.hasLoginWindow()) state = "awaiting-scan";
    else if (keysReady) state = "ready";
    else if (account) state = "awaiting-keys";
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

    await this.ensureClientLink();
  }

  private async ensureClientLink(): Promise<void> {
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
      XDG_RUNTIME_DIR: this.runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(this.runtimeDir, "bus")}`,
    };
  }

  /** Prepare the private session bus before ordinary startup or key capture. */
  async prepareSession(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const result = await this.run(
      "sh",
      [
        "-c",
        'test -S "$1/bus" || exec dbus-daemon --session --fork --address="unix:path=$1/bus"',
        "wechat-session",
        this.runtimeDir,
      ],
      { env: this.clientEnv() },
    );
    if (result.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not start the WeChat session bus: ${result.stderr.trim()}`,
      );
    }
  }

  /** Resume the saved desktop session without capturing keys or replacing account data. */
  start(signal?: AbortSignal): Promise<void> {
    // Setup and a live capability share this runtime. One launch owns the
    // client link and process creation until its command completes.
    this.starting ??= this.startClient(signal).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startClient(signal?: AbortSignal): Promise<void> {
    if (await this.pid()) return;
    if (signal?.aborted) throw signal.reason;
    await this.ensureClientLink();
    await this.prepareSession();

    const started = await this.run(
      "sh",
      [
        "-c",
        `cd "$1" && setsid "$1/wechat" >"$2" 2>&1 </dev/null &`,
        "wechat-start",
        this.canonicalPrefix,
        join(this.prefix, "client.log"),
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
    await this.run("pkill", ["-x", "wechat"]).catch(() => {});
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

/** Read the helper source, so callers that stage it elsewhere
 *  do not each re-derive where it lives. */
export function readHelperSource(): Promise<string> {
  return readFile(helperPath(), "utf8");
}
