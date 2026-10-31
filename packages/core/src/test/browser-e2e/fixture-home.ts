import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

// A fixture home: what a Rome left on disk, kept so a later Rome can boot on
// it. The browser suite's upgrade check seeds one by driving an older Rome,
// then boots the Rome under test on a copy, so every migration in between
// runs over data the older code wrote.
//
// A fixture keeps the profile's database and channel state, and the Claude
// CLI's own session files, which a resumed chat reads. Rome rebuilds the rest
// at boot: the installed apps, memory and the example projects. Paths are
// stored without their leading dot, so the repository's ignore rules for a
// real profile do not hide them.

const PROFILE = ".rome/e2e";
/** Kept paths: where each lives in the home, and where in the fixture. */
const KEPT: Array<[home: string, fixture: string]> = [
  [`${PROFILE}/rome.db`, "profile/rome.db"],
  [`${PROFILE}/wechat`, "profile/wechat"],
  [".claude/projects", "claude/projects"],
];

export function databaseOf(home: string): string {
  return join(home, PROFILE, "rome.db");
}

/** The Claude CLI's name for a working directory's session folder. */
function cliProjectName(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Copies the fixture at `dir` into `home`, which Rome has not booted on. The
 * CLI files its sessions under their working directory, which sits in the
 * home, so the folders of the home the fixture was seeded in are renamed for
 * this one, or a resumed chat would not find its session.
 */
export function restoreFixture(dir: string, home: string): void {
  if (!existsSync(join(dir, "profile/rome.db"))) throw new Error(`${dir} holds no fixture`);
  for (const [inHome, inFixture] of KEPT)
    if (existsSync(join(dir, inFixture)))
      cpSync(join(dir, inFixture), join(home, inHome), { recursive: true });
  const { home: seededIn } = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    home?: string;
  };
  const sessions = join(home, ".claude/projects");
  if (!seededIn || !existsSync(sessions)) return;
  const from = cliProjectName(seededIn);
  for (const name of readdirSync(sessions))
    if (name.startsWith(from))
      renameSync(
        join(sessions, name),
        join(sessions, cliProjectName(home) + name.slice(from.length)),
      );
}

/**
 * Saves `home`, which a running Rome is using, as a fixture at `dir`. The
 * database is written with `VACUUM INTO`, which reads one consistent snapshot
 * while Rome keeps writing, so the copy has no WAL to replay.
 */
export function saveFixture(home: string, dir: string, manifest: unknown): void {
  for (const [, inFixture] of KEPT) rmSync(join(dir, inFixture), { recursive: true, force: true });
  mkdirSync(join(dir, "profile"), { recursive: true });
  const db = new Database(databaseOf(home), { readonly: true });
  try {
    db.prepare("VACUUM INTO ?").run(join(dir, "profile/rome.db"));
  } finally {
    db.close();
  }
  for (const [inHome, inFixture] of KEPT.slice(1))
    if (existsSync(join(home, inHome)))
      cpSync(join(home, inHome), join(dir, inFixture), { recursive: true });
  const saved = { home, ...(manifest as Record<string, unknown>) };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(saved, null, 2)}\n`);
}

/** Runs read-only `sql` against the database of `home`. */
export function queryHome(home: string, sql: string): unknown[] {
  const db = new Database(databaseOf(home), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
