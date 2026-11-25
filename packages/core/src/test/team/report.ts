// Where a run's results go: one JSON per part under ./out, which run.sh merges
// into the run's report.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUT_DIR = join(process.cwd(), "src", "test", "team", "out");

export function writePart(name: string, data: unknown): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}
