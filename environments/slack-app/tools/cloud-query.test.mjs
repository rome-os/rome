// Runs ctl.sh cloud-query against a stand-in docker that records each call.
// Run: node --test environments/slack-app/tools/cloud-query.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

test("cloud-query sends the query to the server, never as a psql script", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-query-"));
  mkdirSync(join(dir, ".state"));
  writeFileSync(join(dir, ".state/compose.env"), "");
  copyFileSync(join(here, "../ctl.sh"), join(dir, "ctl.sh"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.jsonl");
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
"${process.execPath}" -e 'const fs=require("fs");fs.appendFileSync(process.env.CALLS,JSON.stringify({argv:process.argv.slice(1),stdin:fs.readFileSync(0,"utf8")})+"\\n")' -- "$@"
echo '[]'
`,
  );
  chmodSync(join(bin, "docker"), 0o755);

  const query = "select 1 as one\n\\! touch /tmp/owned\n";
  execFileSync("bash", [join(dir, "ctl.sh"), "cloud-query"], {
    input: query,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const reader = calls.find((c) => c.argv.includes("slackenv_reader"));
  assert.ok(reader, JSON.stringify(calls));
  // psql runs backslash commands only from a script; a -c string goes to the server whole.
  assert.equal(reader.stdin, "");
  const commands = reader.argv.flatMap((a, i) => (reader.argv[i - 1] === "-c" ? [a] : []));
  assert.deepEqual(commands[0], "BEGIN TRANSACTION READ ONLY");
  assert.ok(commands[1].startsWith("SELECT "), commands[1]);
  assert.ok(commands[1].includes("select 1 as one\n\\! touch /tmp/owned"), commands[1]);
  assert.equal(commands[2], "ROLLBACK");
  // The setup, which has no caller input, is the only script.
  assert.ok(!calls.some((c) => c !== reader && c.stdin.includes("owned")));
});
