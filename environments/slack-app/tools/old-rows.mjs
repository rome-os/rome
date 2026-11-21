// Whether the rows `old-connections` wrote are still stored, for R10 on a Rome
// that ignores the old Slack kinds but keeps their rows. Read only: it opens
// the instance's database read-only and prints, per kind, the connection's id
// and `stored`, true only when both its `connections` row and its
// `connection_grants` row are there. It prints nothing a row holds.
//
// Usage: node old-rows.mjs --ids '{"slack_bot":"<connection id>","slack":"<connection id>"}'
//          [--db path] [--homes /home/rome,/home/user]
// Prints one JSON object.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
}
let ids;
try {
  ids = JSON.parse(args.ids ?? "");
} catch {
  fail(2, 'usage: old-rows.mjs --ids \'{"slack_bot":"<id>","slack":"<id>"}\'');
}
const homes = (args.homes ?? "/home/rome,/home/user").split(",").filter(Boolean);
const dbPath = args.db ?? findDatabase(homes);
if (!dbPath) fail(2, "no rome.db found under ~/.rome in the instance's homes");

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const has = (sql, id) => typeof id === "string" && db.prepare(sql).get(id) !== undefined;
const out = {};
for (const kind of ["slack_bot", "slack"]) {
  const id = typeof ids?.[kind] === "string" ? ids[kind] : null;
  out[kind] = {
    connection_id: id,
    stored:
      has("SELECT 1 FROM connections WHERE id = ?", id) &&
      has("SELECT 1 FROM connection_grants WHERE custody = ?", id),
  };
}
db.close();
console.log(JSON.stringify(out));

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
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(code);
}
