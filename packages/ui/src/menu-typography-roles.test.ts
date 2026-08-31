import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

const menuSources = {
  "dropdown-menu.tsx": ["text-ui", "text-aux"],
  "context-menu.tsx": ["text-ui", "text-aux"],
  "select.tsx": ["text-ui", "text-aux"],
  "popover.tsx": ["text-ui"],
  "tooltip.tsx": ["text-aux"],
} as const;

const adHocTypography = [
  /\btext-(?:xs|sm|base|lg|xl|\[[^\]]+\])/g,
  /\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[[^\]]+\])/g,
  /\btracking-(?:tighter|tight|normal|wide|wider|widest|\[[^\]]+\])/g,
  /\bleading-(?:none|tight|snug|normal|relaxed|loose|\d+|\[[^\]]+\])/g,
];

describe("menu typography roles", () => {
  it.each(Object.entries(menuSources))("uses only role typography in %s", (file, roles) => {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");

    for (const role of roles) {
      expect(source, `${file} should use ${role}`).toContain(role);
    }

    const offenders = adHocTypography.flatMap((pattern) => source.match(pattern) ?? []);
    expect(offenders, `${file} contains ad-hoc typography`).toEqual([]);
  });
});
