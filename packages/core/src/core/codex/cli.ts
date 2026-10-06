// Single source of truth for locating and invoking the codex CLI.
//
// Two transport surfaces spawn codex: the CodexAppServerProvider (agent turns)
// and the ai-tools auth/rate-limit routes. Both go through here so "how do we
// find the codex binary" lives in exactly one place.

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createRequire } from "node:module";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createLogger } from "../../logger.js";

const log = createLogger("codex-cli");

/** Find an executable named `bin` on PATH, returning its absolute path or null.
 *  `require.resolve` never consults the global npm root, so a globally-installed
 *  codex is invisible to it — we look on PATH ourselves for the fallback. */
function findOnPath(bin: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here / not executable — keep looking
      }
    }
  }
  return null;
}

/** Resolve the codex CLI entrypoint. Order: an explicit `ROME_CODEX_BIN`
 *  override (ops escape hatch / test stub) wins; otherwise prefer the
 *  `@openai/codex` dependency's `bin/codex.js` shim, which locates the
 *  platform-native binary and runs under our own node; if that package isn't
 *  resolvable (e.g. a dev box relying on a globally-installed codex), fall back
 *  to a `codex` on PATH. If none of these exist, throw — there's no codex to
 *  spawn. */
export function resolveCodexExecutable(): { command: string; argsPrefix: string[] } {
  const override = process.env.ROME_CODEX_BIN?.trim();
  if (override) return { command: override, argsPrefix: [] };

  const require = createRequire(import.meta.url);
  try {
    const shim = require.resolve("@openai/codex/bin/codex.js");
    return { command: process.execPath, argsPrefix: [shim] };
  } catch (err) {
    const onPath = findOnPath("codex");
    if (onPath) {
      log.info("@openai/codex not resolvable; using codex from PATH", { path: onPath });
      return { command: onPath, argsPrefix: [] };
    }
    throw new Error(
      "Could not locate the codex CLI: '@openai/codex' is not installed as a dependency " +
        `(${(err as Error).message}) and no 'codex' executable was found on PATH.`,
    );
  }
}

/** Spawn the codex CLI with `args`, resolving the executable (bundled shim or
 *  PATH fallback) so callers never hardcode `"codex"`. */
export function spawnCodex(args: string[], options: SpawnOptions = {}): ChildProcess {
  const { command, argsPrefix } = resolveCodexExecutable();
  return spawn(command, [...argsPrefix, ...args], options);
}

/** Spawn `codex app-server`, framing JSON-RPC over newline-delimited stdio.
 *  stdio is always piped — the JSON-RPC transport reads/writes the child's
 *  streams — so the returned process has non-null stdin/stdout/stderr.
 *  `configArgs` are root `-c key=value` overrides, placed before the
 *  subcommand. */
export function spawnCodexAppServer(
  options: Omit<SpawnOptionsWithoutStdio, "stdio"> = {},
  configArgs: readonly string[] = [],
): ChildProcessWithoutNullStreams {
  const { command, argsPrefix } = resolveCodexExecutable();
  return spawn(command, [...argsPrefix, ...configArgs, "app-server", "--listen", "stdio://"], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
