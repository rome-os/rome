// The dev stack the eval runs against: its container, its database (read
// inside the container only, never from the host), and the frozen snapshot
// each round starts from. docs/concierge-eval.md

import { execFileSync } from "node:child_process";

export interface StackOptions {
  /** The container that runs the backend, `rome-rome-1` for the `rome` stack. */
  container: string;
  /** The stack's dashboard origin, such as `http://rome.rome.localhost:3000`. */
  baseUrl: string;
}

/** Where the snapshots live, inside the container. The folder is a bind mount, so it outlives the container. */
const SNAPSHOTS = "/rome-home/.rome/concierge-eval";
const PROFILE = "/rome-home/.rome/default";

/**
 * What a snapshot holds: the database with its WAL, Concierge memory, project
 * files a task may write, and the provider-side thread state that the
 * database's sessions point at. Credentials (`.codex/auth.json`) and logs are
 * left out, so a restore never rolls back a refreshed sign-in.
 */
const SNAPSHOT_SCRIPT = String.raw`
set -eu
S="${SNAPSHOTS}/$NAME"
rm -rf "$S.tmp" && mkdir -p "$S.tmp/default" "$S.tmp/codex" "$S.tmp/claude"
for f in rome.db rome.db-wal rome.db-shm; do
  [ -e "${PROFILE}/$f" ] && cp -a "${PROFILE}/$f" "$S.tmp/default/"
done
cp -a "${PROFILE}/memory" "$S.tmp/default/memory"
cp -a "${PROFILE}/projects" "$S.tmp/default/projects"
if [ -d /rome-home/.codex/sessions ]; then cp -a /rome-home/.codex/sessions "$S.tmp/codex/sessions"; fi
for f in /rome-home/.codex/*.sqlite /rome-home/.codex/*.sqlite-wal /rome-home/.codex/*.sqlite-shm; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in logs_*) continue ;; esac
  cp -a "$f" "$S.tmp/codex/"
done
if [ -d /rome-home/.claude/projects ]; then cp -a /rome-home/.claude/projects "$S.tmp/claude/projects"; fi
date -u +%Y-%m-%dT%H:%M:%SZ > "$S.tmp/created-at"
rm -rf "$S" && mv "$S.tmp" "$S"
du -sh "$S"
`;

const RESTORE_SCRIPT = String.raw`
set -eu
S="${SNAPSHOTS}/$NAME"
[ -e "$S/default/rome.db" ] || { echo "no snapshot at $S" >&2; exit 3; }
rm -f "${PROFILE}/rome.db" "${PROFILE}/rome.db-wal" "${PROFILE}/rome.db-shm"
for f in rome.db rome.db-wal rome.db-shm; do
  [ -e "$S/default/$f" ] && cp -a "$S/default/$f" "${PROFILE}/"
done
rm -rf "${PROFILE}/memory" "${PROFILE}/projects"
cp -a "$S/default/memory" "${PROFILE}/memory"
cp -a "$S/default/projects" "${PROFILE}/projects"
if [ -d "$S/codex/sessions" ]; then rm -rf /rome-home/.codex/sessions && cp -a "$S/codex/sessions" /rome-home/.codex/sessions; fi
for f in /rome-home/.codex/*.sqlite /rome-home/.codex/*.sqlite-wal /rome-home/.codex/*.sqlite-shm; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in logs_*) continue ;; esac
  rm -f "$f"
done
for f in "$S/codex/"*.sqlite*; do [ -e "$f" ] && cp -a "$f" /rome-home/.codex/; done
if [ -d "$S/claude/projects" ]; then rm -rf /rome-home/.claude/projects && cp -a "$S/claude/projects" /rome-home/.claude/projects; fi
# The copy runs as root, and the volumes keep what it wrote as root: hand
# them back to the user the backend runs as, or it cannot read them.
if [ -n "$OWNER" ]; then chown -R "$OWNER" /rome-home/.claude /rome-home/.codex; fi
echo "restored $(cat "$S/created-at")"
`;

/**
 * Reads the stack's database inside its container, read-only, with the
 * backend's own SQLite driver. Each query runs with its parameters and
 * returns its rows.
 */
const QUERY_SCRIPT = String.raw`
const Database = require("/workspace/packages/core/node_modules/better-sqlite3");
const db = new Database("${PROFILE}/rome.db", { readonly: true, fileMustExist: true });
const queries = JSON.parse(require("fs").readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(queries.map((q) => db.prepare(q.sql).all(...(q.params ?? [])))));
`;

/**
 * Throws unless `name` names a folder right inside the snapshots folder. The
 * restore deletes and replaces live state from it, so `.`, `..` or a path
 * would aim it at the profile itself.
 */
export function checkSnapshotName(name: string): void {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name) || name.includes("..")) {
    throw new Error(
      `bad snapshot name: ${JSON.stringify(name)}. Use letters, digits, ".", "_" and "-", starting with a letter or digit.`,
    );
  }
}

export interface Query {
  sql: string;
  params?: (string | number | null)[];
}

function run(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, {
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export class Stack {
  constructor(readonly options: StackOptions) {}

  /** Runs each query, in one process, and returns each one's rows. */
  query<T = Record<string, unknown>>(queries: Query[]): T[][] {
    const out = run(
      "docker",
      ["exec", "-i", this.options.container, "node", "-e", QUERY_SCRIPT],
      JSON.stringify(queries),
    );
    return JSON.parse(out) as T[][];
  }

  /** An environment variable of the running container, or null. */
  env(name: string): string | null {
    try {
      const value = run("docker", ["exec", this.options.container, "printenv", name]).trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private inspect(format: string): string {
    return run("docker", ["inspect", this.options.container, "--format", format]).trim();
  }

  /**
   * Stops the container, runs `script` in a throwaway container that mounts
   * the same volumes, and starts it again. Nothing writes the database while
   * the script runs.
   */
  private async withBackendStopped(script: string, name: string): Promise<string> {
    checkSnapshotName(name);
    const image = this.inspect("{{.Config.Image}}");
    const owner = this.inspect("{{.Config.User}}");
    run("docker", ["stop", "--time", "30", this.options.container]);
    try {
      return run("docker", [
        "run",
        "--rm",
        "--volumes-from",
        this.options.container,
        "--entrypoint",
        "bash",
        "--user",
        "0:0",
        "-e",
        `NAME=${name}`,
        "-e",
        `OWNER=${owner}`,
        image,
        "-c",
        script,
      ]).trim();
    } finally {
      run("docker", ["start", this.options.container]);
      await this.waitHealthy();
    }
  }

  snapshot(name: string): Promise<string> {
    return this.withBackendStopped(SNAPSHOT_SCRIPT, name);
  }

  restore(name: string): Promise<string> {
    return this.withBackendStopped(RESTORE_SCRIPT, name);
  }

  /** Waits for `/api/health` to answer ok. */
  async waitHealthy(timeoutMs = 5 * 60_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        const res = await fetch(`${this.options.baseUrl}/api/health`);
        if (res.ok && ((await res.json()) as { status?: string }).status === "ok") return;
      } catch {
        // Not up yet.
      }
      await sleep(2000);
    }
    throw new Error(`${this.options.baseUrl}/api/health did not answer ok in ${timeoutMs / 1000}s`);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
