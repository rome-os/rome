// The operating-system seam under DesktopManager: the process table, X lock
// files, TCP ports and detached spawns. The manager holds the rules; this file
// holds only the reads and writes, so tests can replace it whole.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { access, constants, open, readdir, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import { delimiter, join } from "node:path";

/** One running process, as `/proc` shows it to a same-user reader. */
export interface ProcessInfo {
  pid: number;
  argv: string[];
  /** Empty when the environment is not readable, as for another user's process. */
  env: Record<string, string>;
}

/** A process this seam started. `exited` stays false once Rome has restarted,
 *  because only the spawning process sees the exit. */
export interface SpawnedProcess {
  pid: number;
  exited(): boolean;
}

export interface DesktopSystem {
  /** Running processes whose program is one of `programs`. The program is the
   *  base name of argv[0], or of argv[1] for an interpreted script such as
   *  websockify. */
  processes(programs: readonly string[]): Promise<ProcessInfo[]>;
  /** The pid in `/tmp/.X<n>-lock`, or null when there is no readable lock. */
  xLockOwner(display: number): Promise<number | null>;
  /** False for a pid that has exited, including a zombie nobody reaped. */
  pidAlive(pid: number): boolean;
  /** Removes `/tmp/.X<n>-lock` and `/tmp/.X11-unix/X<n>`. Missing files are fine. */
  removeXState(display: number): Promise<void>;
  xSocketExists(display: number): Promise<boolean>;
  portListening(port: number): Promise<boolean>;
  hasProgram(program: string): Promise<boolean>;
  /** Starts `program` in a new session, detached from Rome, with stdout and
   *  stderr appended to `logFile`. Throws when the program cannot be spawned. */
  spawnDetached(
    program: string,
    args: string[],
    env: Record<string, string>,
    logFile: string,
  ): Promise<SpawnedProcess>;
  /** The last lines of `logFile`, or "" when it cannot be read. */
  tail(logFile: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

function programOf(argv: string[]): string[] {
  return argv.slice(0, 2).map((arg) => arg.slice(arg.lastIndexOf("/") + 1));
}

function splitNul(text: string): string[] {
  return text.split("\0").filter((part) => part.length > 0);
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of splitNul(text)) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

export function nodeDesktopSystem(
  paths: { procDir?: string; tmpDir?: string; pathEnv?: string } = {},
): DesktopSystem {
  const procDir = paths.procDir ?? "/proc";
  const tmpDir = paths.tmpDir ?? "/tmp";
  const lockFile = (display: number) => join(tmpDir, `.X${display}-lock`);
  const socketFile = (display: number) => join(tmpDir, ".X11-unix", `X${display}`);

  return {
    async processes(programs) {
      const entries = await readdir(procDir).catch(() => [] as string[]);
      const found: ProcessInfo[] = [];
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        // A process can exit between readdir and these reads. It is then skipped.
        const cmdline = await readFile(join(procDir, entry, "cmdline"), "utf8").catch(() => "");
        const argv = splitNul(cmdline);
        if (argv.length === 0 || !programOf(argv).some((name) => programs.includes(name))) {
          continue;
        }
        const environ = await readFile(join(procDir, entry, "environ"), "utf8").catch(() => "");
        found.push({ pid: Number(entry), argv, env: parseEnv(environ) });
      }
      return found;
    },

    async xLockOwner(display) {
      const text = await readFile(lockFile(display), "utf8").catch(() => null);
      if (text === null) return null;
      const pid = Number.parseInt(text.replace(/\D/g, ""), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    },

    pidAlive(pid) {
      // `/proc/<pid>/stat` exists for every user's process, where `kill -0`
      // from a non-root Rome would fail on another user's X server. A killed
      // X server whose parent never reaps it stays a zombie, which is dead.
      let stat: string;
      try {
        stat = readFileSync(join(procDir, String(pid), "stat"), "utf8");
      } catch {
        return false;
      }
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      return state !== "Z" && state !== "X";
    },

    async removeXState(display) {
      await rm(lockFile(display), { force: true });
      await rm(socketFile(display), { force: true });
    },

    async xSocketExists(display) {
      const info = await stat(socketFile(display)).catch(() => null);
      return info?.isSocket() ?? false;
    },

    portListening(port) {
      return new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        const done = (listening: boolean) => {
          socket.destroy();
          resolve(listening);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.setTimeout(1_000, () => done(false));
      });
    },

    async hasProgram(program) {
      const dirs = (paths.pathEnv ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
      for (const dir of dirs) {
        const ok = await access(join(dir, program), constants.X_OK).then(
          () => true,
          () => false,
        );
        if (ok) return true;
      }
      return false;
    },

    spawnDetached(program, args, env, logFile) {
      return new Promise((resolve, reject) => {
        const fd = openSync(logFile, "a");
        let exited = false;
        const child = spawn(program, args, { detached: true, stdio: ["ignore", fd, fd], env });
        closeSync(fd);
        child.once("error", reject);
        child.once("exit", () => {
          exited = true;
        });
        child.once("spawn", () => {
          child.unref();
          resolve({ pid: child.pid!, exited: () => exited });
        });
      });
    },

    async tail(logFile) {
      const handle = await open(logFile, "r").catch(() => null);
      if (!handle) return "";
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, 4_096);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        return buffer.toString("utf8").split("\n").slice(-20).join("\n").trim();
      } finally {
        await handle.close();
      }
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
