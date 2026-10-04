// WeChat user-account (personal) transport. Channel contract: docs/architecture/channels.md.

import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DESKTOP_SCRIPT, type DesktopSlot, desktopSlot, startDesktopArgs } from "../desktops.js";
import { createLogger } from "../logger.js";
import { checkStoreKeys, deriveStoreKeys, WechatStoreKeysError } from "./wechat-user-store-keys.js";

const log = createLogger("wechat-user");

/**
 * The pinned client build. Rome mirrors this exact build because WeChat's own
 * download URL carries no version and rolls forward. The digest is the pin: the
 * key-recovery step locates its breakpoint by scanning this exact binary, and a
 * silently different client would move it.
 */
export const WECHAT_CLIENT_URL = "https://packages.romeos.io/wechat-4.1.13.9-amd64.deb";
export const WECHAT_CLIENT_SHA256 =
  "096865e050ba0d3c1a23887227e2400bf343037b1d7d658c84c88ff26bfdc17f";

/**
 * The reader's understanding of WeChat's on-disk formats — SQLCipher page
 * layout, zstd message bodies, the sharded message tables — comes from the
 * `wechat-bridge` package, pinned in packages/core. Rome runs its `wechat-cli`
 * command with `-f json`, which answers one envelope per call.
 */
function bridgeEntry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("wechat-bridge/package.json")), "dist", "index.js");
}

/** Where the deb is unpacked to, and the path the client insists on being at. */
export const WECHAT_CANONICAL_PREFIX = "/opt/wechat";

/** The image's AT-SPI bus launcher (Debian `at-spi2-core`). */
export const ACCESSIBILITY_LAUNCHER = "/usr/libexec/at-spi-bus-launcher";

/**
 * Starts accessibility on the client's private session bus: $1 is the launcher.
 * The launcher owns `org.a11y.Bus` there, answers IsEnabled, and runs the
 * accessibility bus the client's Qt AT-SPI bridge joins. That bridge watches
 * for the name, so a client that is already running joins live, with no
 * restart. The launcher runs without DISPLAY: with one it would also publish
 * the bus on the X root window, where Rome's browser on the same display would
 * find and join it. The name can also be owned by a launcher D-Bus activated on
 * its own, which takes IsEnabled from GSettings (usually off), so the script
 * sets IsEnabled on every run rather than trusting ownership. The registry is
 * started up front instead of on first use.
 */
const START_ACCESSIBILITY = `
[ -x "$1" ] || { echo "no accessibility launcher at $1" >&2; exit 1; }
call() { dbus-send --reply-timeout=2000 "$@"; }
owned() {
  call --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \\
    org.freedesktop.DBus.NameHasOwner string:org.a11y.Bus 2>/dev/null | grep -q 'boolean true'
}
if ! owned; then
  env -u DISPLAY -u WAYLAND_DISPLAY setsid "$1" --launch-immediately --a11y=1 >/dev/null 2>&1 </dev/null &
  i=0
  until owned; do
    i=$((i + 1))
    [ "$i" -lt 50 ] || { echo "org.a11y.Bus did not appear" >&2; exit 1; }
    sleep 0.1
  done
fi
call --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.freedesktop.DBus.Properties.Set \\
  string:org.a11y.Status string:IsEnabled variant:boolean:true >/dev/null || exit 1
address=$(call --session --print-reply=literal --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress) || exit 1
call --bus="$(echo $address)" --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \\
  org.freedesktop.DBus.StartServiceByName string:org.a11y.atspi.Registry uint32:0 >/dev/null
`;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Installing downloads and unpacks the better part of a gigabyte. */
const INSTALL_TIMEOUT_MS = 20 * 60_000;
/** How long the start script waits for another run of the same desktop. */
const DESKTOP_LOCK_WAIT_S = 20;
/** The start script's worst case: the lock wait, then up to 30 s for each of
 *  its two ports (wait_for_tcp_port) and 5 s for Openbox, in
 *  scripts/docker/rome-start-desktop.sh. Change those waits there and here
 *  together. The timeout leaves a margin past that, so a busy lock fails with
 *  the script's own message, not a kill. */
const DESKTOP_START_TIMEOUT_MS = (DESKTOP_LOCK_WAIT_S + 30 + 30 + 5 + 15) * 1000;

function sharedDisplay(): string {
  return process.env.DISPLAY || ":99";
}

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

/** `promise`, or `signal`'s reason as soon as it aborts. The work goes on. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

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
  /** The X display the running client is on, or the one a new client starts on. */
  display: string;
  /** The page that shows `display` to the guardian, for sign-in links. */
  desktopPath: string;
  /** The running client is still on the shared display, beside Rome's Chrome,
   *  though WeChat's own desktop can start. It moves there when it next starts:
   *  quitting it lets the health probe start it again on its own desktop, and
   *  the phone may ask to confirm the sign-in. */
  movePending: boolean;
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

// ── bridge shapes ─────────────────────────────────────────────────────────
// The parts of `wechat-cli -f json`'s output the reader keeps. Its `schema`
// command prints the whole contract.

const bridgeEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
  }),
]);

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * A session preview as text. The client sometimes stores the preview as a
 * BLOB, often zstd-compressed, and the bridge passes it through as raw bytes,
 * which JSON renders as an object of byte values. An unreadable preview
 * reads as empty rather than failing the whole session list.
 */
const previewSchema = z
  .union([z.string(), z.record(z.string(), z.number().int().min(0).max(255))])
  .transform((value) => {
    if (typeof value === "string") return value;
    const bytes = Buffer.from(
      Object.keys(value)
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => value[key]!),
    );
    try {
      const plain = bytes.subarray(0, 4).equals(ZSTD_MAGIC)
        ? zstdDecompressSync(bytes, { maxOutputLength: 1 << 20 })
        : bytes;
      return plain.toString("utf8");
    } catch {
      return "";
    }
  });

const bridgeSessionSchema = z.object({
  username: z.string().min(1),
  displayName: z.string(),
  type: z.enum(["private", "group", "official", "folded"]),
  unread: z.number().int().nonnegative(),
  lastMessage: z.object({ content: previewSchema, createdAt: z.string().optional() }).optional(),
});
type BridgeSession = z.infer<typeof bridgeSessionSchema>;

const bridgeMessageSchema = z.object({
  id: z.string().min(1),
  session: z.string().min(1),
  sessionType: z.enum(["private", "group", "official", "folded"]),
  sender: z.string(),
  senderName: z.string().optional(),
  groupNickname: z.string().optional(),
  isSelf: z.boolean(),
  type: z.string(),
  content: z.string(),
  createdAt: z.string(),
});
type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

const bridgePageSchema = z.object({
  messages: z.array(bridgeMessageSchema),
  cursor: z.string().nullable(),
});

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
  /** A fixed X display for the client. It bypasses WeChat's own desktop, and
   *  tests use it. */
  display?: string;
  /** WeChat's own desktop. Defaults to the `wechat` row of the desktop table,
   *  `desktopSlot("wechat")`. Null keeps the client on the shared desktop. */
  desktop?: DesktopSlot | null;
  /** The script that starts the desktop. Defaults to the one in the image. */
  desktopScript?: string;
  /** Where to read a running client's environment. Defaults to /proc. */
  procDir?: string;
  /** The path the client is exposed at. Defaults to its canonical /opt/wechat;
   *  injectable so tests need no writable /opt. */
  canonicalPrefix?: string;
  /** Private session directory owned by the runtime user. */
  runtimeDir?: string;
  /** The AT-SPI bus launcher; injectable so tests need no real one. */
  accessibilityLauncher?: string;
  run?: RunCommand;
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
  private readonly desktop: DesktopSlot | null;
  private readonly desktopScript: string;
  private readonly procDir: string;
  private readonly startDisplay: string;
  readonly canonicalPrefix: string;
  readonly runtimeDir: string;
  readonly accessibilityLauncher: string;
  private readonly run: RunCommand;
  private starting: Promise<void> | null = null;
  private installing: Promise<void> | null = null;
  private captures = 0;
  private keysCheckedAt = 0;
  private bridgeQueue: Promise<unknown> = Promise.resolve();

  constructor(config: WechatUserRuntimeConfig = {}) {
    this.home = config.home ?? process.env.HOME ?? homedir();
    this.prefix = config.prefix ?? join(this.home, ".local", "share", "wechat");
    // WeChat runs on its own desktop (docs/architecture/named-desktops.md).
    this.desktop = config.display
      ? null
      : config.desktop !== undefined
        ? config.desktop
        : desktopSlot("wechat");
    this.desktopScript = config.desktopScript ?? DESKTOP_SCRIPT;
    this.procDir = config.procDir ?? "/proc";
    this.startDisplay = config.display ?? this.desktop?.display ?? sharedDisplay();
    this.canonicalPrefix = config.canonicalPrefix ?? WECHAT_CANONICAL_PREFIX;
    this.runtimeDir = config.runtimeDir ?? wechatRuntimeDir();
    this.accessibilityLauncher = config.accessibilityLauncher ?? ACCESSIBILITY_LAUNCHER;
    this.run = config.run ?? runCommand;
  }

  /** Where the unpacked client lives before it is linked to its canonical path. */
  get clientDir(): string {
    return join(this.prefix, "client", "opt", "wechat");
  }

  /**
   * Hold off every ordinary launch while the connection's setup prepares and
   * runs its key capture, which replaces the client with one under a debugger. `start()` launches nothing until the
   * returned release runs. The capture kills the client on purpose, so nothing,
   * such as the guardian opening /desktop/wechat, may bring an ordinary one back
   * while it runs.
   */
  holdCapture(): () => void {
    this.captures += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.captures -= 1;
    };
  }

  /** Whether a key capture holds the client. */
  get captureInProgress(): boolean {
    return this.captures > 0;
  }

  /** Whether an install is running for any caller. */
  get installInFlight(): boolean {
    return this.installing !== null;
  }

  /** Whether the client is unpacked in this container. */
  installed(): Promise<boolean> {
    return exists(join(this.clientDir, "wechat"));
  }

  /** The bridge's home: its keys file and its decrypted copies of the store,
   *  both private to the runtime user. */
  get bridgeHome(): string {
    return join(this.prefix, "bridge");
  }

  get keysFile(): string {
    return join(this.bridgeHome, "keys.json");
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

  /** The X display a new client starts on. Fixed for the runtime's life: a
   *  running client's own display comes from `status()` or `clientDisplay()`,
   *  and queries never change this. */
  get display(): string {
    return this.startDisplay;
  }

  /** The page that shows `display` to the guardian, for sign-in links. */
  desktopPathFor(display: string): string {
    return this.desktop && display === this.desktop.display ? "/desktop/wechat" : "/desktop";
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
   * The display the client with this pid runs on: its own `DISPLAY`, else the
   * start display. A client already on another display keeps it, because moving
   * it would mean a restart, which can make the phone confirm again. It moves
   * only when it next starts.
   */
  async clientDisplay(pid: number): Promise<string> {
    if (!this.desktop) return this.startDisplay;
    const environ = await readFile(join(this.procDir, String(pid), "environ"), "utf8").catch(
      () => null,
    );
    const entry = environ?.split("\0").find((line) => line.startsWith("DISPLAY="));
    return entry?.slice("DISPLAY=".length) || this.startDisplay;
  }

  /**
   * Start whatever part of WeChat's own desktop has died under a running client
   * on it, such as a crashed websockify that leaves /desktop/wechat broken.
   * Does nothing for a client on another display. Never throws: a repair that
   * fails is logged, and the client keeps running.
   */
  async repairDesktop(signal?: AbortSignal): Promise<void> {
    const pid = await this.pid();
    if (!this.desktop || !pid || (await this.clientDisplay(pid)) !== this.desktop.display) return;
    try {
      await this.ensureDesktop(signal);
    } catch (error) {
      log.warn("wechat_user.desktop_repair_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Start WeChat's own desktop, or reuse it, before a client starts on it. The
   * desktop outlives Rome, so a Rome restart finds it running. Where the start
   * script is not installed, as on a host `pnpm start`, the client stays on the
   * shared desktop. Throws WechatUserRuntimeError when the desktop cannot start.
   *
   * Resolves to the display a new client should start on: `display`, or the
   * shared one where the script is missing. It changes no runtime state, so a
   * repair under a running client cannot move where anything else looks.
   */
  async ensureDesktop(signal?: AbortSignal): Promise<string> {
    const desktop = this.desktop;
    if (!desktop) return this.startDisplay;
    if (!(await exists(this.desktopScript))) {
      log.warn("wechat_user.desktop_unavailable", { script: this.desktopScript });
      return sharedDisplay();
    }
    // env -i: the desktop's programs outlive Rome and need none of its
    // configuration or credentials. ROME_DESKTOP_LOG_DIR passes through so an
    // operator's override applies to every run, which then share one lock.
    const env = [
      `ROME_DESKTOP_LOCK_WAIT=${DESKTOP_LOCK_WAIT_S}`,
      ...["PATH", "HOME", "USER", "LOGNAME", "LANG", "ROME_DESKTOP_LOG_DIR"].flatMap((key) =>
        process.env[key] === undefined ? [] : [`${key}=${process.env[key]}`],
      ),
    ];
    const result = await this.run(
      "env",
      ["-i", ...env, "bash", this.desktopScript, ...startDesktopArgs("wechat", desktop)],
      { timeoutMs: DESKTOP_START_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    if (result.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not start WeChat's desktop: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    return desktop.display;
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
  async captureLoginQr(display: string = this.startDisplay): Promise<string | null> {
    const env = { DISPLAY: display };
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

  private async hasLoginWindow(display: string): Promise<boolean> {
    const tree = await this.run("xwininfo", ["-root", "-tree"], {
      env: { DISPLAY: display },
    });
    if (tree.code !== 0) {
      throw new WechatUserRuntimeError("Could not inspect the WeChat desktop session.");
    }
    const windowId = loginWindowId(tree.stdout);
    if (!windowId) return false;
    const window = await this.run("xwininfo", ["-id", windowId, "-stats", "-size"], {
      env: { DISPLAY: display },
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
    const installed = await this.installed();
    const pid = installed ? await this.pid() : null;
    const scriptInstalled = this.desktop ? await exists(this.desktopScript) : false;
    // A stopped client reports where it will start: the shared display where
    // the start script is missing, as ensureDesktop() falls back to.
    const display = pid
      ? await this.clientDisplay(pid)
      : this.desktop && !scriptInstalled
        ? sharedDisplay()
        : this.startDisplay;
    const account = installed ? await this.accountDir() : null;
    let keysReady = false;
    if (account !== null) {
      if (await exists(this.keysFile)) {
        try {
          await checkStoreKeys({ accountDir: account, keysFile: this.keysFile });
          keysReady = true;
        } catch (error) {
          if (!(error instanceof WechatStoreKeysError)) throw error;
        }
      }
    }

    let state: WechatUserState;
    if (!installed) state = "absent";
    else if (!pid) state = "stopped";
    else if (await this.hasLoginWindow(display)) state = "awaiting-scan";
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
      display,
      desktopPath: this.desktopPathFor(display),
      movePending: Boolean(pid && this.desktop && scriptInstalled && display === sharedDisplay()),
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
  install(signal?: AbortSignal): Promise<void> {
    // The WeChat app and the connection's setup both install. One download and
    // unpack owns the client's files until it completes; a second caller joins
    // it. A caller's signal stops only its own wait, so cancelling one caller
    // never fails another's install, and the download finishes in the background.
    // A caller already cancelled starts nothing.
    if (signal?.aborted && !this.installing) return Promise.reject(signal.reason);
    this.installing ??= this.installClient().finally(() => {
      this.installing = null;
    });
    return signal ? untilAborted(this.installing, signal) : this.installing;
  }

  private async installClient(): Promise<void> {
    const deb = join(this.prefix, "wechat.deb");
    const clientRoot = join(this.prefix, "client");
    await mkdir(this.prefix, { recursive: true });

    if (!(await exists(join(this.clientDir, "wechat")))) {
      await this.fetchClientArchive(deb);
      log.info("wechat_user.unpacking_client", { prefix: clientRoot });
      await mkdir(clientRoot, { recursive: true });
      const unpacked = await this.run("dpkg-deb", ["-x", deb, clientRoot], {
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (unpacked.code !== 0) {
        throw new WechatUserRuntimeError(
          `Could not unpack the WeChat client: ${unpacked.stderr.trim() || "dpkg-deb failed"}`,
        );
      }
    }

    await this.ensureClientLink();
  }

  /**
   * Leave a `deb` at `path` that matches the pinned digest, downloading it if
   * the cache holds nothing or holds the wrong build.
   *
   * The digest admits the cached file rather than merely rejecting it, because
   * `this.prefix` is volume-backed: a rejected file that stays on disk wins the
   * `exists` check forever and every later install fails on it. Verifying the
   * `.part` before the `mv` keeps a wrong download from becoming that file.
   *
   * Only the unpack path calls this, which is what keeps `install()`
   * idempotent. Re-entering it with the client already unpacked has nothing to
   * read the archive for, so it neither downloads a missing one nor hashes the
   * better part of a gigabyte to prove one it will not open.
   */
  private async fetchClientArchive(path: string): Promise<void> {
    if (await exists(path)) {
      const digest = await this.clientDigest(path);
      if (digest === WECHAT_CLIENT_SHA256) return;
      log.warn("wechat_user.cached_client_rejected", {
        path,
        digest,
        expected: WECHAT_CLIENT_SHA256,
      });
      await this.discard(path);
    }

    log.info("wechat_user.downloading_client", { url: WECHAT_CLIENT_URL });
    const downloaded = await this.run(
      "curl",
      ["-fsSL", "--retry", "3", "-o", `${path}.part`, WECHAT_CLIENT_URL],
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    if (downloaded.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not download the WeChat client: ${downloaded.stderr.trim() || "curl failed"}`,
      );
    }

    const digest = await this.clientDigest(`${path}.part`);
    if (digest !== WECHAT_CLIENT_SHA256) {
      await this.discard(`${path}.part`);
      throw new WechatUserRuntimeError(
        `The WeChat client downloaded from ${WECHAT_CLIENT_URL} hashes to ${digest}, not the ` +
          "supported 4.1.13.9 build. Either the pin is out of date or the host is serving the " +
          "wrong file.",
      );
    }

    const promoted = await this.run("mv", [`${path}.part`, path]);
    if (promoted.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not store the WeChat client at ${path}: ${promoted.stderr.trim() || "mv failed"}`,
      );
    }
  }

  /**
   * Remove `path`, best effort.
   *
   * Every caller is already on its way to reporting why the file had to go. A
   * failed unlink must not replace that story with a filesystem one, and it
   * costs nothing: the cache path is overwritten by the `mv` that follows, and
   * a stale `.part` is truncated by the next `curl -o`.
   */
  private async discard(path: string): Promise<void> {
    await rm(path, { force: true }).catch((error: unknown) => {
      log.warn("wechat_user.client_archive_not_removed", { path, error: String(error) });
    });
  }

  /**
   * The sha256 of the file at `path`.
   *
   * A digest this cannot read is not a digest that failed to match. Raising
   * here rather than reporting a mismatch keeps a `sha256sum` that never
   * answered from evicting a cached archive that was the right build all along.
   */
  private async clientDigest(path: string): Promise<string> {
    const checksum = await this.run("sha256sum", [path]);
    if (checksum.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not checksum the WeChat client at ${path}: ` +
          `${checksum.stderr.trim() || "sha256sum failed"}`,
      );
    }
    const digest = checksum.stdout.trim().split(/\s+/)[0] ?? "";
    // An answer this cannot parse is as unread as one that never came, and
    // reporting it as a mismatch would evict the archive it failed to measure.
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new WechatUserRuntimeError(
        `Could not checksum the WeChat client at ${path}: sha256sum answered ` +
          `"${checksum.stdout.trim().slice(0, 80)}"`,
      );
    }
    return digest;
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
  private clientEnv(display: string = this.startDisplay): Record<string, string> {
    return {
      DISPLAY: display,
      HOME: this.home,
      QT_QPA_PLATFORM: "xcb",
      LIBGL_ALWAYS_SOFTWARE: "1",
      XDG_RUNTIME_DIR: this.runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(this.runtimeDir, "bus")}`,
    };
  }

  /**
   * Prepare the private session bus before ordinary startup or key capture, and
   * keep accessibility on it for the client's lifetime. Idempotent: the
   * connection's health probe calls it for a client that is already running.
   */
  async prepareSession(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const result = await this.run(
      "sh",
      [
        "-c",
        // Without DISPLAY: services this bus activates inherit its environment,
        // and an activated AT-SPI launcher would publish the accessibility bus
        // on the X root window.
        'test -S "$1/bus" || exec env -u DISPLAY dbus-daemon --session --fork --address="unix:path=$1/bus"',
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
    await this.ensureAccessibility();
  }

  /** Turn accessibility on for the session bus, which must already exist.
   *  Reading and login need no accessibility, so this never throws: a failure
   *  is logged. Sending checks for the tree itself and reports it as not ready. */
  async ensureAccessibility(): Promise<void> {
    const started = await this.run(
      "sh",
      ["-c", START_ACCESSIBILITY, "wechat-accessibility", this.accessibilityLauncher],
      { env: this.clientEnv(), timeoutMs: 15_000 },
    ).catch((error: unknown) => ({
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));
    if (started.code !== 0) {
      log.warn("wechat_user.accessibility_unavailable", { stderr: started.stderr.trim() });
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
    if (this.captureInProgress) return;
    if (await this.pid()) return;
    if (signal?.aborted) throw signal.reason;
    const display = await this.ensureDesktop(signal);
    await this.ensureClientLink();
    await this.prepareSession();
    // A capture can take the lease during the steps above; it owns the launch.
    if (this.captureInProgress) return;

    const started = await this.run(
      "sh",
      [
        "-c",
        `cd "$1" && setsid "$1/wechat" >"$2" 2>&1 </dev/null &`,
        "wechat-start",
        this.canonicalPrefix,
        join(this.prefix, "client.log"),
      ],
      { env: this.clientEnv(display), ...(signal ? { signal } : {}) },
    );
    if (started.code !== 0) {
      throw new WechatUserRuntimeError(
        `Could not start the WeChat client: ${started.stderr.trim() || "spawn failed"}`,
      );
    }
    log.info("wechat_user.client_started", { display });
  }

  async stop(): Promise<void> {
    await this.run("pkill", ["-x", "wechat"]).catch(() => {});
  }

  /**
   * Turn the captured store passphrase into per-database keys the bridge reads.
   * Throws {@link WechatUserStorePending} while the client is still creating a
   * required database, so the caller retries with the same passphrase, and
   * {@link WechatUserSessionRejected} when only a fresh capture can help.
   */
  async deriveKeys(passphrase: string, signal?: AbortSignal): Promise<void> {
    try {
      await deriveStoreKeys(
        passphrase,
        { accountDir: await this.accountDir(), keysFile: this.keysFile },
        signal,
      );
    } catch (error) {
      throw asSessionFault(error);
    }
  }

  /**
   * Refuse reads until every required database has a key that opens it. The
   * bridge skips a shard it holds no key for, so without this a missing shard
   * reads as a chat with less history rather than as a locked store.
   */
  private async checkKeys(): Promise<void> {
    if (Date.now() - this.keysCheckedAt < KEYS_CHECK_TTL_MS) return;
    try {
      await checkStoreKeys({ accountDir: await this.accountDir(), keysFile: this.keysFile });
    } catch (error) {
      throw asSessionFault(error);
    }
    this.keysCheckedAt = Date.now();
  }

  /**
   * Run one `wechat-cli` command against this container's client and store,
   * answering the envelope's data. The bridge owns everything that needs
   * WeChat's own file formats. Its error codes map onto the reader's faults:
   * no keys (or keys for another account) is a rejected session, a store the
   * client is mid-write on is pending, and anything else is transient.
   */
  async bridgeCommand(args: string[], signal?: AbortSignal): Promise<unknown> {
    // One bridge process at a time: the bridge's decrypt cache has no
    // cross-process lock, so concurrent processes each decrypt the same shards
    // and can leave an older copy marked current.
    const turn = this.bridgeQueue.then(() => {
      signal?.throwIfAborted();
      return this.runBridge(args, signal);
    });
    this.bridgeQueue = turn.catch(() => {});
    return turn;
  }

  private async runBridge(args: string[], signal?: AbortSignal): Promise<unknown> {
    await this.checkKeys();
    const result = await this.run(process.execPath, [bridgeEntry(), "-f", "json", ...args], {
      env: {
        HOME: this.home,
        WECHAT_CLI_HOME: this.bridgeHome,
        WECHAT_DATA_ROOT: join(this.home, "xwechat_files"),
        WECHAT_APP_BINARY: join(this.canonicalPrefix, "wechat"),
      },
      timeoutMs: 5 * 60_000,
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new WechatBridgeError(OUTPUT_TOO_LARGE, "the answer exceeded the output limit");
      }
      throw error;
    });
    let envelope: z.infer<typeof bridgeEnvelopeSchema>;
    try {
      envelope = bridgeEnvelopeSchema.parse(JSON.parse(result.stdout));
    } catch (error) {
      throw new WechatUserRuntimeError(
        `The WeChat reader failed: ${result.stderr.trim() || (error instanceof Error ? error.message : `exit ${result.code}`)}`,
      );
    }
    if (envelope.ok) return envelope.data;
    const { code, message } = envelope.error;
    switch (code) {
      case "KEY_NOT_FOUND":
      case "WECHAT_NOT_FOUND":
        throw new WechatUserSessionRejected(message);
      case "DECRYPT_FAILED":
        throw new WechatUserStorePending(message);
      default:
        throw new WechatBridgeError(code, message);
    }
  }
}

/** How long a successful key check covers later reads. */
const KEYS_CHECK_TTL_MS = 30_000;

/** The code the reader gives an answer too large to capture, so paged reads
 *  can retry with smaller pages. */
const OUTPUT_TOO_LARGE = "OUTPUT_TOO_LARGE";

function asSessionFault(error: unknown): unknown {
  if (!(error instanceof WechatStoreKeysError)) return error;
  return error.kind === "pending"
    ? new WechatUserStorePending(error.message)
    : new WechatUserSessionRejected(error.message);
}

/** A `wechat-cli` failure the reader does not map onto a session fault. */
class WechatBridgeError extends WechatUserRuntimeError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`The WeChat reader failed: ${message}`);
  }
}

// ── reader ────────────────────────────────────────────────────────────────

/** How many recent chats a read across every conversation covers. Bounded on
 *  purpose: sweeping every chat ever opened is minutes of work, and the caller
 *  asked for a page. */
const RECENT_CONVERSATIONS = 20;

/** How long a chat's display name, read for messages that do not carry it,
 *  is reused before the session list is read again. */
const NAMES_TTL_MS = 60_000;

/** The first page size for counting and for reading a whole second. A page
 *  whose answer overflows the output limit is retried at half the size. */
const COUNT_PAGE = 1_000;
const TIES_PAGE = 200;

/** A rich message's body is its whole serialized envelope, which is CDN keys
 *  and AES material rather than anything anyone said. Keep what precedes it. */
const ENVELOPE_MARKERS = ["<?xml", "<msg>", "<msg "];
const MAX_TEXT = 4000;

function cleanText(text: string): string {
  let cut = text.length;
  for (const marker of ENVELOPE_MARKERS) {
    const found = text.indexOf(marker);
    if (found !== -1) cut = Math.min(cut, found);
  }
  return text.slice(0, cut).trim().slice(0, MAX_TEXT);
}

function toUnixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function isoSeconds(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

/** The folded entries (folded group chats, subscriptions) are rows in the
 *  session list, not chats. */
function isChat(session: BridgeSession): boolean {
  return session.type !== "folded";
}

function toConversation(session: BridgeSession): WechatUserConversation {
  // A group's preview is prefixed by its sender's id.
  const preview = session.lastMessage?.content ?? "";
  const createdAt = session.lastMessage?.createdAt;
  return wechatUserConversationSchema.parse({
    id: session.username,
    name: session.displayName,
    isGroup: session.type === "group",
    unread: session.unread,
    lastMessageAt: createdAt ? toUnixSeconds(createdAt) : null,
    lastMessagePreview: preview.includes(":\n")
      ? preview.split(":\n").slice(1).join(":\n")
      : preview,
  });
}

/**
 * A bridge message in the reader's shape. A direct chat's message with no
 * resolvable sender is the other party's. A non-text message the bridge
 * renders as its raw envelope reads as a short placeholder, because a
 * transcript that drops it silently misreads the conversation.
 */
function toMessage(
  message: BridgeMessage,
  conversationName: string | undefined,
): WechatUserMessage {
  const isGroup = message.sessionType === "group";
  const senderId = message.sender || (isGroup ? "" : message.session);
  const senderName = message.groupNickname || message.senderName;
  return wechatUserMessageSchema.parse({
    id: message.id,
    conversationId: message.session,
    ...(conversationName ? { conversationName } : {}),
    isGroup,
    senderId,
    ...(senderName ? { senderName } : {}),
    isSelf: message.isSelf,
    timestamp: toUnixSeconds(message.createdAt),
    type: message.type,
    text: cleanText(message.content) || `[${message.type}]`,
  });
}

/** Reads the signed-in account's own store. Every call is a live query: the
 *  client's SQLite is the record, so a Rome-side copy would only add staleness. */
export class WechatUserReader {
  private names: { at: number; byId: Promise<Map<string, string>> } | null = null;

  constructor(private readonly runtime: WechatUserRuntime) {}

  /**
   * Every chat, most recently active first. The bridge orders by the client's
   * sort key, which puts pinned chats first however old, so the whole list is
   * read and ordered by last message before any limit applies.
   */
  private async sessions(signal?: AbortSignal): Promise<BridgeSession[]> {
    const data = await this.runtime.bridgeCommand(["sessions"], signal);
    const lastAt = (session: BridgeSession) =>
      session.lastMessage?.createdAt ? Date.parse(session.lastMessage.createdAt) : 0;
    return z
      .array(bridgeSessionSchema)
      .parse(data)
      .filter(isChat)
      .sort((a, b) => lastAt(b) - lastAt(a));
  }

  async conversations(
    input: { query?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<WechatUserConversation[]> {
    const needle = input.query?.toLowerCase();
    return (await this.sessions(signal))
      .filter((session) => session.lastMessage?.createdAt)
      .filter(
        (session) =>
          !needle ||
          session.displayName.toLowerCase().includes(needle) ||
          session.username.toLowerCase().includes(needle),
      )
      .slice(0, input.limit)
      .map(toConversation);
  }

  /** Chat display names, which the bridge's messages do not carry. */
  private conversationNames(signal?: AbortSignal): Promise<Map<string, string>> {
    if (!this.names || Date.now() - this.names.at > NAMES_TTL_MS) {
      const byId = this.sessions(signal).then(
        (sessions) => new Map(sessions.map((session) => [session.username, session.displayName])),
      );
      byId.catch(() => {
        this.names = null;
      });
      this.names = { at: Date.now(), byId };
    }
    return this.names.byId;
  }

  private async page(
    conversationId: string,
    window: { since?: Date; until?: Date; limit: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof bridgePageSchema>> {
    const args = ["query", conversationId, "-n", String(window.limit)];
    if (window.since) args.push("--since", isoSeconds(window.since));
    if (window.until) args.push("--until", isoSeconds(window.until));
    if (window.cursor) args.push("--cursor", window.cursor);
    try {
      return bridgePageSchema.parse(await this.runtime.bridgeCommand(args, signal));
    } catch (error) {
      if (error instanceof WechatBridgeError && error.code === "SESSION_NOT_FOUND") {
        return { messages: [], cursor: null };
      }
      throw error;
    }
  }

  /**
   * Every page of a chat's window, newest page first, each oldest first. A page
   * too large to capture is asked for again at half the size, so long bodies
   * slow a sweep down instead of failing it.
   */
  private async *pages(
    conversationId: string,
    window: { since?: Date; until?: Date },
    limit: number,
    signal?: AbortSignal,
  ): AsyncGenerator<BridgeMessage[]> {
    let cursor: string | null = null;
    for (;;) {
      let page: z.infer<typeof bridgePageSchema>;
      try {
        page = await this.page(
          conversationId,
          { ...window, limit, ...(cursor ? { cursor } : {}) },
          signal,
        );
      } catch (error) {
        if (error instanceof WechatBridgeError && error.code === OUTPUT_TOO_LARGE && limit > 1) {
          limit = Math.ceil(limit / 2);
          continue;
        }
        throw error;
      }
      yield page.messages;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }

  /** Every message a chat holds in the second starting at `at`, oldest first. */
  private async second(
    conversationId: string,
    at: Date,
    signal?: AbortSignal,
  ): Promise<BridgeMessage[]> {
    const messages: BridgeMessage[] = [];
    for await (const page of this.pages(
      conversationId,
      { since: at, until: at },
      TIES_PAGE,
      signal,
    )) {
      messages.unshift(...page);
    }
    return messages;
  }

  /**
   * One chat's newest `limit` messages at or after `since` and at or before
   * `before`, oldest first.
   *
   * With `includeBoundaryTies` the window is for paging by timestamp: every
   * message in the `before` second, plus the newest `limit` strictly older
   * ones with every tie at their oldest second. A second holding more than
   * `limit` messages then cannot stall the caller's paging on itself.
   */
  private async chatMessages(
    conversationId: string,
    input: { since?: Date; before?: Date; limit: number; includeBoundaryTies?: boolean },
    signal?: AbortSignal,
  ): Promise<BridgeMessage[]> {
    const since = input.since ? { since: input.since } : {};
    if (!input.includeBoundaryTies) {
      const window = { ...since, ...(input.before ? { until: input.before } : {}) };
      return (await this.page(conversationId, { ...window, limit: input.limit }, signal)).messages;
    }

    const sinceSecond = input.since ? toUnixSeconds(input.since.toISOString()) : null;
    const beforeSecond = input.before ? toUnixSeconds(input.before.toISOString()) : null;
    let older: BridgeMessage[] = [];
    if (beforeSecond === null || sinceSecond === null || beforeSecond - 1 >= sinceSecond) {
      const until = beforeSecond === null ? {} : { until: new Date((beforeSecond - 1) * 1000) };
      const page = await this.page(
        conversationId,
        { ...since, ...until, limit: input.limit },
        signal,
      );
      older = page.messages;
      const edge = older[0];
      // With older history left, the oldest second may continue past the page.
      if (edge && page.cursor) {
        const edgeSecond = toUnixSeconds(edge.createdAt);
        older = [
          ...(await this.second(conversationId, new Date(edgeSecond * 1000), signal)),
          ...older.filter((message) => toUnixSeconds(message.createdAt) !== edgeSecond),
        ];
      }
    }
    const atBefore =
      beforeSecond !== null && (sinceSecond === null || beforeSecond >= sinceSecond)
        ? await this.second(conversationId, new Date(beforeSecond * 1000), signal)
        : [];
    return [...older, ...atBefore];
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
    const names = await this.conversationNames(signal).catch(() => new Map<string, string>());
    if (input.conversationId) {
      const messages = await this.chatMessages(input.conversationId, input, signal);
      return messages.map((message) => toMessage(message, names.get(message.session)));
    }
    // No chat named: read across the most recently active ones.
    const recent = (await this.sessions(signal)).slice(0, RECENT_CONVERSATIONS);
    const window = {
      ...(input.since ? { since: input.since } : {}),
      ...(input.before ? { before: input.before } : {}),
      limit: input.limit,
    };
    const perChat = await Promise.all(
      recent.map((session) => this.chatMessages(session.username, window, signal)),
    );
    return perChat
      .flat()
      .map((message) => toMessage(message, names.get(message.session)))
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-input.limit);
  }

  /** Total messages in a chat, counted a page at a time so a long chat never
   *  arrives as one oversized answer. */
  async count(conversationId: string, signal?: AbortSignal): Promise<number> {
    let total = 0;
    for await (const page of this.pages(conversationId, {}, COUNT_PAGE, signal)) {
      total += page.length;
    }
    return total;
  }
}
