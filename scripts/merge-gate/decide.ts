// Prints the merge gate's decision for one PR as JSON on stdout.
//
//   pnpm exec tsx scripts/merge-gate/decide.ts <input.json>
//
// Reads only the input file: no network, no git, no other files. Exits 0 with a
// decision, or 1 with a message on stderr when the input is missing or malformed.

import { readFileSync } from "node:fs";
import { decide } from "./gate.js";
import { MalformedInput, parseInput } from "./input.js";

function main(argv: string[]): number {
  const file = argv[0];
  if (!file || argv.length > 1) {
    process.stderr.write("usage: decide.ts <input.json>\n");
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    process.stderr.write(`merge-gate: cannot read ${file} as JSON: ${(err as Error).message}\n`);
    return 1;
  }
  try {
    const decision = decide(parseInput(raw));
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof MalformedInput) {
      process.stderr.write(`merge-gate: malformed input: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

process.exitCode = main(process.argv.slice(2));
