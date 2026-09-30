// Named desktops. Contract and invariants: docs/architecture/named-desktops.md.
import { join } from "node:path";
import { Mutex } from "async-mutex";
import { createLogger } from "../logger.js";
import {
  type DesktopSystem,
  type ProcessInfo,
  type SpawnedProcess,
  nodeDesktopSystem,
} from "./system.js";

const log = createLogger("desktops");

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** `/desktop-proxy/websockify` is the shared desktop's socket path. */
const RESERVED_NAMES = new Set(["websockify"]);

/** Slot k is display :100+k, RFB port 5901+k and websockify port 6081+k.
 *  Slot 0 is the triple the entrypoint gives WeChat's own display. */
const FIRST_DISPLAY = 100;
const FIRST_VNC_PORT = 5901;
const FIRST_NOVNC_PORT = 6081;
const SLOT_COUNT = 64;

/** The environment variable that ties each process to its desktop's name. */
const NAME_MARKER = "ROME_DESKTOP";
const PROGRAMS = ["Xtigervnc", "openbox", "websockify"] as const;
const DEFAULT_GEOMETRY = "1280x800";
const READY_POLL_MS = 250;
const OPENBOX_GRACE_MS = 1_000;

export interface DesktopSlot {
  display: number;
  vncPort: number;
  novncPort: number;
}

export interface Desktop {
  name: string;
  /** The X display, such as ":100". */
  display: string;
  vncPort: number;
  novncPort: number;
  /** The dashboard page that shows this desktop, "/desktop/<name>". */
  path: string;
}

export interface AcquireOptions {
  /** WIDTHxHEIGHT, used only when this call starts the X server. */
  geometry?: string;
  /** An Openbox rc file, used only when this call starts Openbox. */
  openboxConfig?: string;
}

/** The desktop stack is not installed, as on a host `pnpm start` outside the
 *  container. Callers fall back to the shared display. */
export class DesktopUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopUnavailable";
  }
}

/** A name that `/desktop/<name>` and `/desktop-proxy/<name>/` can carry. */
export function isDesktopName(name: string): boolean {
  return NAME_PATTERN.test(name) && !RESERVED_NAMES.has(name);
}

function slotAt(k: number): DesktopSlot {
  return {
    display: FIRST_DISPLAY + k,
    vncPort: FIRST_VNC_PORT + k,
    novncPort: FIRST_NOVNC_PORT + k,
  };
}

function overlaps(a: DesktopSlot, b: DesktopSlot): boolean {
  return a.display === b.display || a.vncPort === b.vncPort || a.novncPort === b.novncPort;
}

function argAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function runsDisplay(proc: ProcessInfo, display: number): boolean {
  return proc.argv.includes(`:${display}`);
}

function isProgram(proc: ProcessInfo, program: string): boolean {
  return proc.argv.slice(0, 2).some((arg) => arg.slice(arg.lastIndexOf("/") + 1) === program);
}

export interface DesktopManagerOptions {
  system?: DesktopSystem;
  /** Fixed slots for names that must not move, such as legacy
   *  `WECHAT_USER_DISPLAY`. A pinned name adopts a matching X server with or
   *  without the name marker, and fails rather than move when its slot is taken. */
  pins?: Record<string, DesktopSlot>;
  /** Where each process's log goes, as `<program>-<name>.log`. */
  logDir?: string;
  readyTimeoutMs?: number;
}

export class DesktopManager {
  private readonly system: DesktopSystem;
  private readonly pins: Record<string, DesktopSlot>;
  private readonly logDir: string;
  private readonly readyTimeoutMs: number;
  private readonly lock = new Mutex();

  constructor(options: DesktopManagerOptions = {}) {
    this.system = options.system ?? nodeDesktopSystem();
    this.pins = options.pins ?? {};
    this.logDir = options.logDir ?? "/tmp";
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  }

  /**
   * The running desktop for `name`, or null. Never starts or repairs anything,
   * so a viewer cannot create a display: a desktop counts as running only when
   * both its X server and its websockify are up.
   */
  async get(name: string): Promise<Desktop | null> {
    if (!isDesktopName(name)) return null;
    const procs = await this.system.processes(PROGRAMS);
    const slot = this.runningSlot(name, procs);
    if (!slot || !this.findWebsockify(procs, slot)) return null;
    return toDesktop(name, slot);
  }

  /**
   * A running desktop for `name`. Adopts whatever part of it already runs,
   * including processes left by an earlier Rome, and starts only what is
   * missing. The processes outlive Rome and end with the container.
   *
   * Idempotent and cheap once the desktop runs, so callers may re-acquire on
   * every health check to heal a crashed display. Calls are serialised.
   * Throws DesktopUnavailable when the desktop stack is not installed, and an
   * Error when a process fails to start or the slot is held by something else.
   */
  async acquire(name: string, options: AcquireOptions = {}): Promise<Desktop> {
    if (!isDesktopName(name)) {
      throw new Error(`Invalid desktop name "${name}"`);
    }
    const geometry = options.geometry ?? DEFAULT_GEOMETRY;
    if (!/^\d+x\d+$/.test(geometry)) {
      throw new Error(`Invalid desktop geometry "${geometry}"`);
    }
    return this.lock.runExclusive(async () => {
      for (const program of PROGRAMS) {
        if (!(await this.system.hasProgram(program))) {
          throw new DesktopUnavailable(`${program} is not installed`);
        }
      }
      const procs = await this.system.processes(PROGRAMS);
      const running = this.runningSlot(name, procs);
      const slot = running ?? this.pins[name] ?? (await this.freeSlot(name, procs));
      if (running) {
        log.info("desktop adopted", { name, display: `:${slot.display}` });
      } else {
        await this.startX(name, slot, geometry);
      }
      await this.ensureOpenbox(name, slot, procs, options.openboxConfig);
      await this.ensureWebsockify(name, slot, procs);
      return toDesktop(name, slot);
    });
  }

  /** The slot whose X server belongs to `name`: a pinned name matches its
   *  pin's display and RFB port, any other name matches the name marker. */
  private runningSlot(name: string, procs: ProcessInfo[]): DesktopSlot | null {
    const servers = procs.filter((proc) => isProgram(proc, "Xtigervnc"));
    const pin = this.pins[name];
    if (pin) {
      const found = servers.some(
        (proc) =>
          runsDisplay(proc, pin.display) && argAfter(proc.argv, "-rfbport") === String(pin.vncPort),
      );
      return found ? pin : null;
    }
    for (const proc of servers) {
      if (proc.env[NAME_MARKER] !== name) continue;
      const display = proc.argv.find((arg) => /^:\d+$/.test(arg));
      const k = display ? Number(display.slice(1)) - FIRST_DISPLAY : -1;
      if (k < 0 || k >= SLOT_COUNT) continue;
      const slot = slotAt(k);
      if (argAfter(proc.argv, "-rfbport") === String(slot.vncPort)) return slot;
    }
    return null;
  }

  private async freeSlot(name: string, procs: ProcessInfo[]): Promise<DesktopSlot> {
    const otherPins = Object.entries(this.pins)
      .filter(([pinned]) => pinned !== name)
      .map(([, slot]) => slot);
    for (let k = 0; k < SLOT_COUNT; k++) {
      const slot = slotAt(k);
      if (otherPins.some((pin) => overlaps(pin, slot))) continue;
      if (procs.some((proc) => isProgram(proc, "Xtigervnc") && runsDisplay(proc, slot.display))) {
        continue;
      }
      if (await this.xServerAlive(slot.display)) continue;
      if (await this.system.portListening(slot.vncPort)) continue;
      if (await this.system.portListening(slot.novncPort)) continue;
      return slot;
    }
    throw new Error(`No free desktop slot for "${name}"`);
  }

  private async xServerAlive(display: number): Promise<boolean> {
    const owner = await this.system.xLockOwner(display);
    return owner !== null && this.system.pidAlive(owner);
  }

  private async startX(name: string, slot: DesktopSlot, geometry: string): Promise<void> {
    if (await this.xServerAlive(slot.display)) {
      throw new Error(`The existing X server on :${slot.display} is not Rome's TigerVNC process`);
    }
    // A lock or socket without a live owner is left from a server that died.
    await this.system.removeXState(slot.display);
    if (await this.system.portListening(slot.vncPort)) {
      throw new Error(`TCP port ${slot.vncPort} is already in use by another process`);
    }
    const logFile = this.logFile("xtigervnc", name);
    log.info("desktop starting", { name, display: `:${slot.display}`, vncPort: slot.vncPort });
    const spawned = await this.system.spawnDetached(
      "Xtigervnc",
      [
        `:${slot.display}`,
        "-geometry",
        geometry,
        "-depth",
        "24",
        "-SecurityTypes",
        "None",
        "-localhost",
        "yes",
        "-rfbport",
        String(slot.vncPort),
        "-AlwaysShared",
        "-AcceptCutText",
        "-SendCutText",
        "-ac",
      ],
      this.env(name),
      logFile,
    );
    await this.waitReady(
      "TigerVNC",
      spawned,
      logFile,
      async () =>
        (await this.system.xSocketExists(slot.display)) &&
        (await this.system.portListening(slot.vncPort)),
    );
  }

  private async ensureOpenbox(
    name: string,
    slot: DesktopSlot,
    procs: ProcessInfo[],
    config: string | undefined,
  ): Promise<void> {
    const display = `:${slot.display}`;
    if (procs.some((proc) => isProgram(proc, "openbox") && proc.env.DISPLAY === display)) return;
    const logFile = this.logFile("openbox", name);
    const spawned = await this.system.spawnDetached(
      "openbox",
      config ? ["--config-file", config] : [],
      { ...this.env(name), DISPLAY: display },
      logFile,
    );
    // Openbox has no readiness signal. It exits at once when it cannot run, as
    // when another window manager holds the display, so a short grace catches that.
    for (let waited = 0; waited < OPENBOX_GRACE_MS; waited += READY_POLL_MS) {
      if (spawned.exited()) {
        throw new Error(`Openbox exited during startup: ${await this.system.tail(logFile)}`);
      }
      await this.system.sleep(READY_POLL_MS);
    }
  }

  private findWebsockify(procs: ProcessInfo[], slot: DesktopSlot): ProcessInfo | undefined {
    return procs.find(
      (proc) =>
        isProgram(proc, "websockify") &&
        proc.argv.includes(`127.0.0.1:${slot.novncPort}`) &&
        proc.argv.includes(`localhost:${slot.vncPort}`),
    );
  }

  private async ensureWebsockify(
    name: string,
    slot: DesktopSlot,
    procs: ProcessInfo[],
  ): Promise<void> {
    if (this.findWebsockify(procs, slot)) return;
    if (await this.system.portListening(slot.novncPort)) {
      throw new Error(`TCP port ${slot.novncPort} is already in use by another process`);
    }
    const logFile = this.logFile("websockify", name);
    const spawned = await this.system.spawnDetached(
      "websockify",
      [`127.0.0.1:${slot.novncPort}`, `localhost:${slot.vncPort}`],
      this.env(name),
      logFile,
    );
    await this.waitReady("websockify", spawned, logFile, () =>
      this.system.portListening(slot.novncPort),
    );
  }

  private async waitReady(
    label: string,
    spawned: SpawnedProcess,
    logFile: string,
    ready: () => Promise<boolean>,
  ): Promise<void> {
    for (let waited = 0; waited < this.readyTimeoutMs; waited += READY_POLL_MS) {
      if (await ready()) return;
      if (spawned.exited()) {
        throw new Error(`${label} exited during startup: ${await this.system.tail(logFile)}`);
      }
      await this.system.sleep(READY_POLL_MS);
    }
    throw new Error(
      `${label} was not ready within ${this.readyTimeoutMs / 1000} s: ${await this.system.tail(logFile)}`,
    );
  }

  private logFile(program: string, name: string): string {
    return join(this.logDir, `${program}-${name}.log`);
  }

  /** A small environment: the display processes live as long as the container
   *  and need none of Rome's configuration or credentials. */
  private env(name: string): Record<string, string> {
    const env: Record<string, string> = { [NAME_MARKER]: name };
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }
}

function toDesktop(name: string, slot: DesktopSlot): Desktop {
  return {
    name,
    display: `:${slot.display}`,
    vncPort: slot.vncPort,
    novncPort: slot.novncPort,
    path: `/desktop/${name}`,
  };
}
