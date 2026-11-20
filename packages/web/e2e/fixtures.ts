import { test as base, expect } from "@playwright/test";
import {
  checkConstraints,
  cropFinding,
  formatFinding,
  loadConstraints,
} from "./layout-constraints/check.js";

const constraints = loadConstraints();

/**
 * `@playwright/test` with one addition: when a test passes, the layout
 * constraints in `layout-constraints/*.constraints.json` are checked against the
 * page it ended on. A constraint applies only where its scope renders, so every
 * page any test reaches is checked without a route list. A finding fails the
 * test and attaches a crop with the measured boxes outlined.
 */
export const test = base.extend<{ layoutConstraints: void }>({
  layoutConstraints: [
    async ({ page }, use, testInfo) => {
      await use();
      if (testInfo.status !== "passed" || page.isClosed() || page.url() === "about:blank") return;
      const findings = await checkConstraints(page, constraints);
      // One crop per broken constraint: the same break usually repeats down a list.
      const firstPerId = findings.filter((f, i) => findings.findIndex((g) => g.id === f.id) === i);
      for (const f of firstPerId) {
        const constraint = constraints.find((c) => c.id === f.id);
        const png = constraint ? await cropFinding(page, f, constraint) : null;
        if (png) {
          await testInfo.attach(`layout-${f.kind}-${f.id}.png`, {
            body: png,
            contentType: "image/png",
          });
        }
      }
      expect(
        findings,
        `layout constraints broken on ${page.url()}:\n${findings.map(formatFinding).join("\n")}`,
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export * from "@playwright/test";
export { expect };
