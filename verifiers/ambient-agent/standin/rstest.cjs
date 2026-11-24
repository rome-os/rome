#!/usr/bin/env node
// Stands in for rstest in the stand-in product checkout (up.mjs). It runs no
// TypeScript: it reports each test named in the file it is given as rstest
// prints one, passing all, or failing the recall test when the checkout's
// .standin-4b says the stand-in connection needs more than three things.

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const file = process.argv[process.argv.length - 1];
if (process.argv[2] !== "run" || !existsSync(file)) {
  console.error(`no test file ${file}`);
  process.exit(1);
}
const mode = readFileSync(join(process.cwd(), "../../.standin-4b"), "utf8");
const names = [...readFileSync(file, "utf8").matchAll(/\b(?:it|test)\(\s*["'`]([^"'`]+)/g)].map(
  (m) => m[1],
);
let failed = 0;
for (const name of names) {
  const fail = mode === "needs-more" && name.startsWith("recall");
  if (fail) failed++;
  console.log(`  ${fail ? "✗" : "✓"} ambient agent > ${name}`);
  if (fail) console.log("    the stand-in connection offers no directory");
}
console.log(
  `      Tests ${failed ? `${failed} failed | ` : ""}${names.length - failed} passed (${names.length})`,
);
process.exit(failed ? 1 : 0);
