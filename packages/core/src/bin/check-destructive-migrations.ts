// Fails when an unreleased system migration drops or renames a table or column
// that the last release still declares. The rule is in DEVELOPMENT.md under
// "Established patterns".
//
// Usage: pnpm db:check:destructive [--since <rev>]
//
// The last release is the newest `v*` tag reachable from HEAD unless --since
// names another revision. HEAD is read from the working tree, so a migration
// generated but not yet committed is checked too.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findDeclaredRemovals,
  type MigrationSql,
  type SchemaSnapshot,
} from "../db/destructive-migration-check.js";

const MIGRATIONS_DIR = "packages/core/drizzle/system";
const UPSTREAM_REPOSITORY = "rome-os/rome";

interface Journal {
  entries: { tag: string }[];
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr.trim() };
}

/** The file's content at `rev`, or null when the path does not exist there. */
function readAtRevision(rev: string, path: string): string | null {
  if (!git(["cat-file", "-e", `${rev}:${path}`]).ok) return null;
  const shown = git(["show", `${rev}:${path}`]);
  if (!shown.ok) throw new Error(`git show ${rev}:${path} failed: ${shown.stderr}`);
  return shown.stdout;
}

function readRequiredAtRevision(rev: string, path: string): string {
  const content = readAtRevision(rev, path);
  if (content === null) throw new Error(`${path} does not exist at ${rev}`);
  return content;
}

/**
 * The newest snapshot among `fileNames`, which is the one drizzle-kit diffs the
 * schema against. Not every migration has a snapshot, so the newest journal
 * entry is not a reliable name for it.
 */
function newestSnapshotPath(fileNames: string[]): string {
  const newest = fileNames
    .map((fileName) => fileName.split("/").at(-1) ?? fileName)
    .filter((fileName) => /^\d{4}_snapshot\.json$/.test(fileName))
    .sort()
    .at(-1);
  if (!newest) throw new Error(`no drizzle snapshot found in ${MIGRATIONS_DIR}/meta`);
  return `${MIGRATIONS_DIR}/meta/${newest}`;
}

function listAtRevision(rev: string, dir: string): string[] {
  const listed = git(["ls-tree", "--name-only", `${rev}:${dir}`]);
  if (!listed.ok) throw new Error(`git ls-tree ${rev}:${dir} failed: ${listed.stderr}`);
  return listed.stdout.split("\n").filter(Boolean);
}

function parseSinceArg(argv: string[]): string | undefined {
  const index = argv.indexOf("--since");
  if (index === -1) return undefined;
  const rev = argv[index + 1];
  if (!rev) throw new Error("--since needs a revision");
  return rev;
}

function main(): number {
  const toplevel = git(["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) throw new Error(`not inside a git checkout: ${toplevel.stderr}`);
  const repoRoot = toplevel.stdout.trim();
  process.chdir(repoRoot);

  let release = parseSinceArg(process.argv.slice(2));
  if (!release) {
    const described = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"]);
    if (!described.ok) {
      const repository = process.env.GITHUB_REPOSITORY;
      if (repository && repository !== UPSTREAM_REPOSITORY) {
        // Release tags are only cut upstream, so a fork's CI has nothing to compare against.
        console.warn(
          `check-destructive-migrations: no release tag in ${repository}; skipping the check.`,
        );
        return 0;
      }
      console.error(
        "check-destructive-migrations: ERROR: no v* release tag is reachable from HEAD.\n" +
          "Fetch the tags (`git fetch --tags`, or `fetch-depth: 0` in CI) or name the last\n" +
          `release with --since <rev>. git said: ${described.stderr}`,
      );
      return 1;
    }
    release = described.stdout.trim();
  }

  const shippedJournal = JSON.parse(
    readRequiredAtRevision(release, `${MIGRATIONS_DIR}/meta/_journal.json`),
  ) as Journal;
  const headJournal = JSON.parse(
    readFileSync(join(repoRoot, MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const shippedTags = new Set(shippedJournal.entries.map((entry) => entry.tag));

  // Every migration is read from HEAD. A shipped migration is never edited, so
  // HEAD's copy is the one the release ran.
  const migrations: MigrationSql[] = headJournal.entries.map((entry) => ({
    name: entry.tag,
    sql: readFileSync(join(repoRoot, MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8"),
    shipped: shippedTags.has(entry.tag),
  }));
  const unshippedCount = migrations.filter((migration) => !migration.shipped).length;

  const violations = findDeclaredRemovals({
    shippedSnapshot: JSON.parse(
      readRequiredAtRevision(
        release,
        newestSnapshotPath(listAtRevision(release, `${MIGRATIONS_DIR}/meta`)),
      ),
    ) as SchemaSnapshot,
    migrations,
  });

  if (violations.length === 0) {
    console.log(
      `check-destructive-migrations: ${unshippedCount} migration(s) since ${release} keep every object ${release} reads.`,
    );
    return 0;
  }

  console.error(
    `check-destructive-migrations: ERROR: these objects are removed, but ${release} still declares them.\n` +
      `Rolling back to ${release} after this migration fails on any read of them.\n`,
  );
  for (const violation of violations) {
    const name = violation.column ? `${violation.table}.${violation.column}` : violation.table;
    console.error(`  ${name} (removed by ${violation.migration})`);
  }
  console.error(
    "\nFirst ship a release that no longer declares the object and whose migration keeps it\n" +
      "in the database. Drop it in a later release. See DEVELOPMENT.md, Established patterns.",
  );
  return 1;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(
    `check-destructive-migrations: ERROR: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
}
