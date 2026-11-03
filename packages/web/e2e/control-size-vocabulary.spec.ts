import { expect, test } from "@playwright/test";

/**
 * The Control role's central promise, measured: two members given the same size
 * name are the same height, so a row of them needs no per-call-site nudging.
 * `sm` and `md` are the steps that promise applies to — every member carries
 * them. `lg` and `xs` are the Button family's own, for a standalone call to
 * action and a chip beside body text, and no field implements either.
 *
 * The kit's unit tests pin which `--control-h-*` token each member resolves
 * through, which is the half jsdom can see. This is the other half — the token
 * has to arrive from the host's `:root` and survive the cascade, and only a
 * real browser resolves that. A member that reads the right token and still
 * renders the wrong height fails here and nowhere else.
 *
 * `/dev/gallery` is the page that renders every primitive at every size, so
 * the sweep needs no fixture of its own.
 */

/**
 * Control-role slots. A member outside this set sizes on its own scale.
 *
 * `segmented-control` is the track, not a segment: the track is the box that
 * joins a row, and its height is the step. A segment sits inside it and takes
 * the track's padding.
 */
const CONTROL_SLOTS = [
  "button",
  "icon-button",
  "input",
  "select-trigger",
  "toggle",
  "segmented-control",
];

/**
 * The invariant covers a member's own geometry, so a composite that resizes one
 * through the `className` override contract is out of scope. `Calendar` is the
 * one in-tree case: its day and navigation buttons take the 28px `--cell-size`
 * grid measure rather than the step their size name would give, which is a
 * known divergence rather than a drift this sweep should keep re-reporting.
 */
const OVERRIDDEN_BY_COMPOSITE = '[data-slot="calendar"]';

test("a size name means one height across every Control member", async ({ page }) => {
  await page.goto("/dev/gallery");
  // A shared runner can render the route far slower than a warm local machine.
  await expect(page.locator('[data-slot="icon-button"]').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);

  const heightsBySize = await page.evaluate(
    ({ slots, excluded }) => {
      const found: Record<string, { slot: string; height: number }[]> = {};

      for (const slot of slots) {
        for (const node of document.querySelectorAll(`[data-slot="${slot}"][data-size]`)) {
          if (node.closest(excluded)) continue;
          const size = node.getAttribute("data-size");
          if (!size) continue;
          const { height } = node.getBoundingClientRect();
          // A specimen scrolled out of view or inside a closed overlay measures
          // 0 and would read as a mismatch against a rendered sibling.
          if (height === 0) continue;
          (found[size] ??= []).push({ slot, height: Math.round(height) });
        }
      }

      return found;
    },
    { slots: CONTROL_SLOTS, excluded: OVERRIDDEN_BY_COMPOSITE },
  );

  // The sweep is only meaningful if the page actually rendered the members.
  expect(Object.keys(heightsBySize).sort()).toEqual(
    expect.arrayContaining(["icon-sm", "md", "sm"]),
  );

  // The shared steps are the ones a mixed row depends on, so each has to reach
  // more than one kind of member for the uniformity check below to mean
  // anything.
  for (const step of ["sm", "md"]) {
    const slots = new Set((heightsBySize[step] ?? []).map((m) => m.slot));
    expect(slots.size, `only ${[...slots]} rendered at ${step}`).toBeGreaterThan(1);
  }

  const disagreements = Object.entries(heightsBySize)
    .map(([size, members]) => {
      const heights = [...new Set(members.map((m) => m.height))];
      if (heights.length === 1) return null;
      const detail = members.map((m) => `${m.slot}=${m.height}px`).join(", ");
      return `  size="${size}" renders ${heights.length} heights: ${detail}`;
    })
    .filter((entry): entry is string => entry !== null);

  expect(
    disagreements,
    `one size name, more than one height:\n${disagreements.join("\n")}`,
  ).toEqual([]);
});

test("the square members agree with the ladder they name", async ({ page }) => {
  await page.goto("/dev/gallery");
  await expect(page.locator('[data-slot="icon-button"]').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);

  const squares = await page.evaluate((excluded) => {
    const rows: { slot: string; size: string; width: number; height: number }[] = [];

    for (const node of document.querySelectorAll(
      '[data-slot="icon-button"][data-size], [data-slot="button"][data-size^="icon-"]',
    )) {
      if (node.closest(excluded)) continue;
      const size = node.getAttribute("data-size") ?? "";
      const { width, height } = node.getBoundingClientRect();
      if (height === 0) continue;
      rows.push({
        slot: node.getAttribute("data-slot") ?? "",
        size,
        width: Math.round(width),
        height: Math.round(height),
      });
    }

    return rows;
  }, OVERRIDDEN_BY_COMPOSITE);

  expect(squares.length).toBeGreaterThan(0);

  // Square is the contract — an icon control that grows with its glyph stops
  // being a predictable step in a toolbar.
  for (const square of squares) {
    expect(square.width, `${square.slot} at ${square.size} is not square`).toBe(square.height);
  }

  // `IconButton size="sm"` and `Button size="icon-sm"` are the same control at
  // the same step, so they cannot render two boxes.
  for (const step of ["sm", "md", "lg"]) {
    const iconButton = squares.find((s) => s.slot === "icon-button" && s.size === step);
    const button = squares.find((s) => s.slot === "button" && s.size === `icon-${step}`);
    if (!iconButton || !button) continue;

    expect(
      iconButton.height,
      `IconButton ${step} (${iconButton.height}px) and Button icon-${step} (${button.height}px) disagree`,
    ).toBe(button.height);
  }
});
