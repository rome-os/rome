// ctl.sh find-secret: where inside an instance any of the given strings is
// stored, as counts only. Read only. It runs inside the instance (or its image
// when the instance is stopped) and looks in:
//   - every text the instance's database holds: each table and column, as
//     "db:<table>.<column>", plus "grant:<connection id>" for each grant whose
//     credential holds one;
//   - every file under the homes and /run, as "file:<path>".
// ctl.sh adds the instance's logs ("logs") from the host. Nothing a string
// matches is printed, and neither are the strings: counts are listed in the
// order the strings were given.
//
// Usage: node find-secret.mjs --strings '["…","…"]' [--db path] [--homes /home/rome,/home/user] [--roots /run]
// Prints {places: {place: [count per string]}} with only the places that hold one.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
}
let strings;
try {
  strings = JSON.parse(args.strings ?? "");
} catch {}
if (!Array.isArray(strings) || !strings.length || !strings.every((s) => typeof s === "string" && s))
  fail(2, "usage: find-secret.mjs --strings '[\"<non-empty string>\", ...]'");
const homes = (args.homes ?? "/home/rome,/home/user").split(",").filter(Boolean);
const roots = [...homes, ...(args.roots ?? "/run").split(",").filter(Boolean)];

const places = {};
const note = (place, counts) => {
  if (counts.some((n) => n > 0)) places[place] = counts;
};

// The database
const dbPath = args.db ?? findDatabase(homes);
if (dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  const quote = (name) => `"${name.replaceAll('"', '""')}"`;
  for (const table of tables) {
    for (const { name: column } of db.prepare(`PRAGMA table_info(${quote(table)})`).all()) {
      const count = db.prepare(
        `SELECT count(*) AS n FROM ${quote(table)} WHERE instr(CAST(${quote(column)} AS TEXT), ?) > 0`,
      );
      note(
        `db:${table}.${column}`,
        strings.map((s) => count.get(s).n),
      );
    }
  }
  if (tables.includes("connection_grants")) {
    const grants = db.prepare(
      "SELECT custody, CAST(credential AS TEXT) AS c FROM connection_grants",
    );
    for (const { custody, c } of grants.all())
      note(
        `grant:${custody}`,
        strings.map((s) => occurrences(Buffer.from(c ?? ""), Buffer.from(s))),
      );
  }
  db.close();
}

// The files
const needles = strings.map((s) => Buffer.from(s));
for (const root of roots) walk(root);

console.log(JSON.stringify({ db: dbPath, roots, places }));

function walk(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    let names = [];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) walk(join(path, name));
    return;
  }
  if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return;
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return;
  }
  note(
    `file:${path}`,
    needles.map((n) => occurrences(bytes, n)),
  );
}

function occurrences(haystack, needle) {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

function findDatabase(roots) {
  const found = [];
  for (const root of roots) {
    const dir = join(root, ".rome");
    if (!existsSync(dir)) continue;
    for (const profile of readdirSync(dir)) {
      const path = join(dir, profile, "rome.db");
      if (existsSync(path)) found.push({ path, at: statSync(path).mtimeMs });
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.path ?? null;
}

function fail(code, error) {
  console.log(JSON.stringify({ error }));
  process.exit(code);
}
