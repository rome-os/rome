// Where the eval's checks put their outcomes. A check never fails its test:
// the eval measures, so a run always finishes and the scorecard shows what
// holds and what does not.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type Quality = "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6" | "Q7" | "Q8";

export interface Outcome {
  readonly quality: Quality;
  readonly platform: string;
  readonly check: string;
  readonly outcome: "pass" | "fail" | "n/a";
  readonly detail?: string;
}

/** The eval's output folder, relative to `packages/core`, where every eval
 *  command runs. */
export const OUT_DIR = resolve(process.cwd(), "src/test/eval/chats-adapter/out");

const outcomes: Outcome[] = [];

/**
 * Run `body` as one check of `quality` on `platform`. It passes when `body`
 * resolves and fails when it throws, with the error's words as the detail.
 * `applies` false records the check as not applying to the platform.
 */
export async function check(
  quality: Quality,
  platform: string,
  name: string,
  body: () => Promise<void>,
  applies = true,
): Promise<void> {
  if (!applies) {
    outcomes.push({ quality, platform, check: name, outcome: "n/a" });
    return;
  }
  try {
    await body();
    outcomes.push({ quality, platform, check: name, outcome: "pass" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcomes.push({
      quality,
      platform,
      check: name,
      outcome: "fail",
      detail: detail.slice(0, 300),
    });
  }
}

/** Fails the check with `detail` unless `holds`. */
export function expectThat(holds: boolean, detail: string): void {
  if (!holds) throw new Error(detail);
}

/** Write every outcome recorded in this run to `out/<file>`. */
export function writeOutcomes(file: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, file), `${JSON.stringify(outcomes, null, 2)}\n`);
}
