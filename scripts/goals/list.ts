// Lists each goal under <root>/goals/ with its remaining counts, and marks the
// goals ready to close. Contract: "Command: list" in the goals contract.
//
//   npx --yes tsx@4.21.0 scripts/goals/list.ts [--root <dir>] [--json]
//
// Exits 0 whatever the checks find, and 2 for bad arguments.

import { formatList, listJson } from "./cli.js";
import { main } from "./main.js";

void main("list", process.argv.slice(2), (args, report) => ({
  out: args.json ? `${JSON.stringify(listJson(report), null, 2)}\n` : formatList(report),
  code: 0,
})).then((code) => {
  process.exitCode = code;
});
