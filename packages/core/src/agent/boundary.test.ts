import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { checkAgentBoundaries, compareWithBaseline, formatViolation } from "./boundary-check.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(here);
const baseline = readFileSync(join(here, "boundary-baseline.txt"), "utf8");

describe("agent context boundaries", () => {
  // The baseline is a ratchet: known crossings pass while they are migrated,
  // and an entry must leave the baseline once its crossing is gone.
  const { unlisted, stale } = compareWithBaseline(checkAgentBoundaries(srcDir), baseline);

  it("no import outside the baseline crosses a layer of the agent context", () => {
    const lines = unlisted.map(formatViolation);
    expect(lines, `\nNew crossings, fix them:\n${lines.join("\n")}\n`).toEqual([]);
  });

  it("every baseline entry still occurs", () => {
    expect(
      stale,
      `\nStale entries, remove them from boundary-baseline.txt:\n${stale.join("\n")}\n`,
    ).toEqual([]);
  });
});
