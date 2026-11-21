// The shared entry point of check.ts and list.ts: parses arguments, runs the
// goals, and prints. Check code runs with console output and stdout sent to
// stderr, so `--json` prints exactly one JSON object to stdout.

import { type Args, parseArgs } from "./cli.js";
import { type Report, runGoals } from "./goals.js";

/** Resolves to the exit code: 2 for bad arguments, otherwise the code `print` returns. */
export async function main(
  command: string,
  argv: string[],
  print: (args: Args, report: Report) => { out: string; code: number },
): Promise<number> {
  const args = parseArgs(argv, process.cwd());
  if ("usage" in args) {
    process.stderr.write(
      `goals ${command}: ${args.usage}\nusage: ${command}.ts [--root <dir>] [--json]\n`,
    );
    return 2;
  }
  const report = await withStdoutOnStderr(() => runGoals(args.root));
  const { out, code } = print(args, report);
  process.stdout.write(out);
  return code;
}

async function withStdoutOnStderr<T>(run: () => Promise<T>): Promise<T> {
  const write = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = write;
  }
}
