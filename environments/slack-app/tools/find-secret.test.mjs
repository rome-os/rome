// Run: ROME_SRC=<rome checkout> node --test environments/slack-app/tools/find-secret.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const romeSrc = process.env.ROME_SRC ?? join(here, "../../..");
const tool = join(here, "find-secret.mjs");

test("find-secret counts each string per place and prints none of them", () => {
  const root = mkdtempSync(join(tmpdir(), "find-secret-"));
  const home = join(root, "home");
  const run = join(root, "run");
  mkdirSync(join(home, ".rome", "default"), { recursive: true });
  mkdirSync(run);
  const path = join(home, ".rome", "default", "rome.db");
  const db = new DatabaseSync(path);
  const dir = join(romeSrc, "packages/core/drizzle/system");
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const s of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint"))
      if (s.trim()) db.exec(s);
  }
  const bot = "xoxb-TA0000AAAA-0123456789abcdef";
  const never = "xoxp-never-stored-0000";
  db.prepare(
    "INSERT INTO connection_grants (custody, state, credential) VALUES ('c-slack-app', 'authorized', ?)",
  ).run(JSON.stringify({ kind: "bearer", material: { token: bot } }));
  db.close();
  writeFileSync(join(run, "token"), `${bot}\n${bot}\n`);

  const out = execFileSync(process.execPath, [
    tool,
    "--strings",
    JSON.stringify([bot, never]),
    "--homes",
    home,
    "--roots",
    run,
  ]).toString();
  const { places } = JSON.parse(out);
  assert.deepEqual(places["db:connection_grants.credential"], [1, 0]);
  assert.deepEqual(places["grant:c-slack-app"], [1, 0]);
  assert.deepEqual(places[`file:${join(run, "token")}`], [2, 0]);
  assert.ok(Object.values(places).every(([, n]) => n === 0));
  assert.ok(!out.includes(bot) && !out.includes(never));

  // Strings must be a non-empty list of non-empty strings.
  assert.throws(() => execFileSync(process.execPath, [tool, "--strings", "[]"], { stdio: "pipe" }));
});
