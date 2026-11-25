// The team verifier's sandbox. Every verifier test file imports this file
// before anything else, so it runs before any product module loads: product
// modules that read HOME when they load (`anthropic/refused-credential.ts`
// keeps `~/.claude`, `codex/cli-auth.ts` keeps `~/.codex`) keep the sandbox's
// home, never the developer's. This file imports no product code.
//
// It also guards every program the process launches through
// `node:child_process`. While an instance is open, a launch runs only a stub
// from the sandbox's `bin`: a program the sandbox has a stub for runs that
// stub, whatever PATH the caller built, and anything else runs `refused`,
// which exits 127 and is listed by `refusedLaunches`. A launched program sees
// only the stubs on its PATH. Not covered: node-pty, which the terminal
// socket spawns its shell through, and later words of a shell command that
// name a program by absolute path.

import { ChildProcess } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterAll } from "@rstest/core";

const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const root = mkdtempSync(join(tmpdir(), "rome-team-sandbox-"));

/** The home every product module sees from load on, and the stubs a launch may run. */
export const SANDBOX = {
  /** HOME as the test process was started with it. */
  originalHome: originalEnv.HOME,
  home: join(root, "home"),
  bin: join(root, "bin"),
};

mkdirSync(SANDBOX.home, { recursive: true });
mkdirSync(SANDBOX.bin, { recursive: true });
process.env.HOME = SANDBOX.home;
process.env.USERPROFILE = SANDBOX.home;

const REFUSED = join(SANDBOX.bin, "refused");

function findOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return null;
}

function writeStub(name: string, body: string): void {
  writeFileSync(join(SANDBOX.bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// The CLIs routes reach for. Each fails as a CLI that is installed but not
// signed in would, so no route reaches an account on the developer's machine.
for (const name of ["claude", "codex", "opencli", "composio", "gh", "linkedin"]) {
  writeStub(name, "exit 1");
}
// Git runs for real on local repositories, such as the profile's memory
// folder, with every transport but the local file one turned off.
const realGit = findOnPath("git", process.env.PATH);
writeStub(
  "git",
  realGit
    ? `GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 exec '${realGit}' "$@"`
    : "exit 127",
);
writeStub("refused", 'echo "the team verifier refused to launch: $*" >&2\nexit 127');

const refused: string[] = [];
let openGuards = 0;

/** The programs launches asked for and the guard refused, in order. */
export function refusedLaunches(): readonly string[] {
  return refused;
}

/** Turns the launch guard on for one open instance. The returned function
 *  turns it off once every caller that turned it on has called it. */
export function guardLaunches(): () => void {
  openGuards += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openGuards -= 1;
  };
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The stub that runs for `program`, or null when the guard refuses it. */
function stubFor(program: string): string | null {
  const name = basename(program);
  if (name === "refused") return null;
  const stub = join(SANDBOX.bin, name);
  if (program === stub) return stub;
  if (program.includes("/")) return null;
  return findOnPath(name, SANDBOX.bin);
}

/** What runs in place of `program`: its stub, or `refused` naming it. */
function route(program: string, args: string[]): { file: string; args: string[] } {
  const stub = stubFor(program);
  if (stub) return { file: stub, args };
  refused.push([program, ...args].join(" "));
  return { file: REFUSED, args: [program, ...args] };
}

// A shell command's program is its first word after any `NAME=value`.
const SHELL_COMMAND = /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)("[^"]*"|'[^']*'|\S+)([\s\S]*)$/;

function routeShellCommand(command: string): string {
  const match = SHELL_COMMAND.exec(command);
  if (!match) return command;
  const [, assignments, word, rest] = match;
  const program = word.replace(/^["']|["']$/g, "");
  const stub = stubFor(program);
  if (stub) return `${assignments}${quote(stub)}${rest}`;
  refused.push(command.trim());
  return `${quote(REFUSED)} ${quote(command.trim())}`;
}

// Every launch reaches one of two calls with the command already resolved to
// a file and an argv, a shell command as `[shell, "-c", command]`: the
// asynchronous ones (`spawn`, `exec`, `execFile`, `fork`) `ChildProcess#spawn`,
// the synchronous ones the `spawn_sync` binding's `spawn`. Both are patched in
// place, since a bundled module may hold its own copy of `node:child_process`'s
// exports. Neither is in Node's typings.
type LaunchOptions = { file: string; args: string[]; envPairs?: string[] };
type Launch = (this: unknown, options: LaunchOptions) => unknown;

function guardLaunch(options: LaunchOptions): void {
  const [argv0 = options.file, ...rest] = options.args;
  if (SHELLS.has(basename(options.file)) && rest[0] === "-c" && rest.length >= 2) {
    options.args = [argv0, "-c", routeShellCommand(rest[1]), ...rest.slice(2)];
  } else {
    const routed = route(options.file, rest);
    options.file = routed.file;
    options.args = [routed.file, ...routed.args];
  }
  options.envPairs = [
    ...(options.envPairs ?? []).filter((pair) => !pair.startsWith("PATH=")),
    `PATH=${SANDBOX.bin}`,
  ];
}

const launchers = [
  ChildProcess.prototype as unknown as { spawn: Launch },
  (process as unknown as { binding(name: string): { spawn: Launch } }).binding("spawn_sync"),
];
const unguarded = launchers.map((launcher) => launcher.spawn);
launchers.forEach((launcher, index) => {
  launcher.spawn = function (options) {
    if (openGuards > 0) guardLaunch(options);
    return unguarded[index].call(this, options);
  };
});

afterAll(() => {
  launchers.forEach((launcher, index) => {
    launcher.spawn = unguarded[index];
  });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
