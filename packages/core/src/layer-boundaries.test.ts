import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { checkLayerBoundaries, formatLayerViolation } from "./test/layer-boundaries.js";

const srcDir = dirname(fileURLToPath(import.meta.url));

/** Contexts laid out as `<context>/<layer>`. A context adopting the layout joins this list. */
const LAYERED_CONTEXTS = ["agent"];

describe("layered context imports", () => {
  it("follow the layer rules", () => {
    const lines = checkLayerBoundaries(
      srcDir,
      join(srcDir, "..", "tsconfig.json"),
      LAYERED_CONTEXTS,
    ).map(formatLayerViolation);
    expect(lines, `\nImports that break a layer rule:\n${lines.join("\n")}\n`).toEqual([]);
  });
});
