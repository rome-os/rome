import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

const sheet = readFileSync(join(import.meta.dirname, "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The body of the phone `@media` block, braces matched. */
function phoneBlock(): string {
  const start = sheet.indexOf("@media (width < 48rem)");
  if (start < 0) throw new Error("No phone block");
  const open = sheet.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < sheet.length; index += 1) {
    if (sheet[index] === "{") depth += 1;
    if (sheet[index] === "}" && (depth -= 1) === 0) return sheet.slice(open + 1, index);
  }
  throw new Error("Unterminated phone block");
}

const block = phoneBlock();
const tokens = new Map(
  [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
    name,
    value.trim(),
  ]),
);

/** Every `--rome-*` step in the sheet, resolved to a number (px or ratio). */
const steps = new Map(
  [...sheet.matchAll(/(--rome-(?:font-size|size|line-height)-\d+)\s*:\s*([^;]+);/g)].map(
    ([, name, value]) => {
      const rem = value.match(/^([\d.]+)rem$/);
      const calc = value.match(/^calc\(([\d.]+) \/ ([\d.]+)\)$/);
      const number = rem
        ? Number(rem[1]) * 16
        : calc
          ? Number(calc[1]) / Number(calc[2])
          : Number(value);
      return [name, number];
    },
  ),
);

const step = (token: string) => {
  const name = tokens.get(token)?.match(/^var\((--rome-[a-z0-9-]+)\)$/)?.[1];
  if (!name) throw new Error(`${token} is not a step reference: ${tokens.get(token)}`);
  const value = steps.get(name);
  if (value === undefined) throw new Error(`No step ${name}`);
  return value;
};

/**
 * Below 768px the kit paints every control it sizes at the 44px touch floor
 * and raises the type to match. The block is the whole mechanism: components
 * read these tokens, so a value that drifts here drifts on every phone.
 */
describe("the phone scale", () => {
  it("paints both shared control steps at the 44px floor", () => {
    expect(step("--control-h-sm")).toBe(44);
    expect(step("--control-h-md")).toBe(44);
  });

  it.each([
    ["ui", 17, 24],
    ["section", 17, 24],
    ["title", 28, 36],
    ["aux", 15, 20],
    ["badge", 15, 20],
  ])("sets %s to %spx on a %spx line box", (role, size, line) => {
    expect(step(`--text-${role}`)).toBe(size);
    const box = size * step(`--text-${role}--line-height`);
    expect(box).toBeCloseTo(line, 6);
  });

  it("keeps every phone line box on the 4px grid, above the 1.2 descender floor", () => {
    for (const role of ["ui", "section", "title", "aux", "badge"]) {
      const size = step(`--text-${role}`);
      const ratio = step(`--text-${role}--line-height`);
      expect(Math.round(size * ratio * 1000) % 4000, role).toBe(0);
      expect(ratio, role).toBeGreaterThanOrEqual(1.2);
    }
  });

  it("weights the large title and the section heading", () => {
    expect(tokens.get("--text-title--font-weight")).toBe("700");
    expect(tokens.get("--text-section--font-weight")).toBe("600");
  });

  it("never sets a field under the size mobile Safari zooms on focus", () => {
    expect(block).toMatch(
      /:where\(input, textarea, select\)\s*\{\s*font-size: max\(var\(--rome-font-size-16\), var\(--text-ui\)\);/,
    );
  });

  it("is not inside a cascade layer, so it outranks the roles' theme layer", () => {
    const before = sheet.slice(0, sheet.indexOf("@media (width < 48rem)"));
    const opened = (before.match(/@layer[^{;]*\{/g) ?? []).length;
    // Every layer block opened before the phone block has closed by then.
    let depth = 0;
    let insideLayer = 0;
    for (const match of before.matchAll(/@layer[^{;]*\{|\{|\}/g)) {
      if (match[0].startsWith("@layer")) insideLayer += 1;
      if (match[0].endsWith("{")) depth += 1;
      else depth -= 1;
    }
    expect(depth).toBe(0);
    expect(opened).toBe(insideLayer);
  });
});
