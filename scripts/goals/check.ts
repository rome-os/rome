// Runs every goal's checks under <root>/goals/ and compares each count with
// its baseline. Contract: "Command: check" in the goals contract.
//
//   npx --yes tsx@4.21.0 scripts/goals/check.ts [--root <dir>] [--json]
//
// Exits 0 when every check is ok and no goal has a problem, 1 otherwise, and
// 2 for bad arguments.

import { checkJson, formatCheck } from "./cli.js";
import { main } from "./main.js";

void main("check", process.argv.slice(2), (args, report) => ({
  out: args.json ? `${JSON.stringify(checkJson(report), null, 2)}\n` : formatCheck(report),
  code: report.ok ? 0 : 1,
})).then((code) => {
  process.exitCode = code;
});
