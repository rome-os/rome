import { expect, test } from "@playwright/test";

/**
 * A glyph's size belongs to the component that holds it, not to the call site.
 * The kit's unit tests pin which rule each component carries, which is the half
 * jsdom can see: a class string is not CSS, and `[&_svg:not([class*='size-'])]`
 * asserted from a `classList` proves only that someone typed it. This is the
 * other half — Tailwind has to emit the rule, the selector has to match, and it
 * has to survive the cascade against whatever the glyph itself carries.
 *
 * `/dev/gallery` renders every primitive at every size, so the sweep needs no
 * fixture of its own.
 */

/** Box height → glyph size, the ladder in `docs/ui/component-roles.md`. */
const LADDER: Record<string, number> = { xs: 12, sm: 14, md: 16, lg: 16 };

async function glyphSizes(page: import("@playwright/test").Page, slot: string) {
  return page.evaluate((selector) => {
    const found: Record<string, { box: number; glyph: number; glyphClass: string }> = {};

    for (const host of document.querySelectorAll(`[data-slot="${selector}"][data-size]`)) {
      const size = host.getAttribute("data-size");
      const svg = host.querySelector("svg");
      if (!size || !svg) continue;
      found[size] = {
        box: Math.round(parseFloat(getComputedStyle(host).height)),
        // `width`, not a bounding rect: the Spinner specimens are mid-rotation,
        // and a rotated box measures up to √2 times its own size.
        glyph: Math.round(parseFloat(getComputedStyle(svg).width)),
        glyphClass: svg.getAttribute("class") ?? "",
      };
    }
    return found;
  }, slot);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/dev/gallery");
  // A shared runner can render the route far slower than a warm local machine.
  await expect(page.locator('[data-slot="icon-button"]').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
});

test("IconButton sizes its glyph from the step, not from the call site", async ({ page }) => {
  const measured = await glyphSizes(page, "icon-button");

  expect(Object.keys(measured).sort()).toEqual(["lg", "md", "sm", "xs"]);
  for (const [step, glyph] of Object.entries(LADDER)) {
    expect(measured[step], `IconButton ${step}`).toMatchObject({ glyph });
    // The specimen hands over a bare lucide glyph. If a call site starts
    // sizing it again the assertion above still passes, so pin the absence.
    expect(measured[step].glyphClass, `IconButton ${step} glyph`).not.toContain("size-");
  }
});

test("IconButton and Button's icon-* agree on the glyph at every shared name", async ({ page }) => {
  const icons = await glyphSizes(page, "icon-button");
  const buttons = await glyphSizes(page, "button");

  // The two ladders are value-identical by contract, and the box already is.
  // A toolbar mixing them keeps one optical inset only if the glyph does too.
  for (const step of Object.keys(LADDER)) {
    expect(buttons[`icon-${step}`], `Button icon-${step}`).toMatchObject({
      box: icons[step].box,
      glyph: icons[step].glyph,
    });
  }
});

test("a size name means one glyph across every Control member that names it", async ({ page }) => {
  const members = ["button", "icon-button", "input-icon", "select-trigger"];
  const measured = Object.fromEntries(
    await Promise.all(members.map(async (slot) => [slot, await glyphSizes(page, slot)] as const)),
  );

  // The row promise the Control role exists for, applied to the glyph: two
  // members given the same size name agree, so a Select beside a Button needs
  // no per-call-site nudge to stop its chevron reading a step larger.
  for (const step of ["sm", "md"] as const) {
    for (const slot of members) {
      expect(measured[slot][step]?.glyph, `${slot} ${step}`).toBe(LADDER[step]);
    }
  }
});

test("SegmentedControl reads the track's step, and TabsTrigger the one it pads on", async ({
  page,
}) => {
  const measured = await page.evaluate(() => {
    const width = (svg: Element) => Math.round(parseFloat(getComputedStyle(svg).width));
    const segments: Record<string, number[]> = {};

    for (const track of document.querySelectorAll('[data-slot="segmented-control"][data-size]')) {
      const step = track.getAttribute("data-size") ?? "?";
      const glyphs = [...track.querySelectorAll("svg")].map(width);
      if (glyphs.length) (segments[step] ??= []).push(...glyphs);
    }
    const tabs = [...document.querySelectorAll('[data-slot="tabs-trigger"]')]
      .flatMap((trigger) => [...trigger.querySelectorAll("svg")])
      .map(width);
    return { segments, tabs };
  });

  // A segment is the track minus the track's own padding, so the step is the
  // track's — otherwise `sm` and `md` switchers would both land on 16px.
  expect(Object.keys(measured.segments).length).toBeGreaterThan(0);
  for (const [step, glyphs] of Object.entries(measured.segments)) {
    for (const glyph of glyphs) expect(glyph, `segment ${step}`).toBe(LADDER[step]);
  }
  // The gallery's "Tabs with a glyph" specimen is the only tab in-tree that
  // carries one, so it is the whole of this measurement — keep it, or the
  // assertion silently degrades to an empty loop.
  expect(measured.tabs.length).toBeGreaterThan(0);
  for (const glyph of measured.tabs) expect(glyph).toBe(LADDER.sm);
});

test("Calendar's one chevron takes the size of whichever row holds it", async ({ page }) => {
  const measured = await page.evaluate(() => {
    const width = (svg: Element) => Math.round(parseFloat(getComputedStyle(svg).width));
    // One class per call, never a comma-joined list: a comma splits at the top
    // level, so an interpolated group would drop the `[data-slot]` prefix from
    // every branch after the first and measure the button rather than its glyph.
    const pick = (...classes: string[]) =>
      classes
        .flatMap((name) => [...document.querySelectorAll(`[data-slot="calendar"] .${name} svg`)])
        .map(width);

    return {
      nav: pick("rdp-button_previous", "rdp-button_next"),
      caption: pick("rdp-dropdown_root"),
    };
  });

  // One `Chevron` renderer feeds both rows and writes no size of its own, so
  // each host's rule is what fires. If the renderer starts sizing the glyph
  // again both numbers collapse to it and both rules go dead with no error.
  expect(measured.nav.length).toBeGreaterThan(0);
  expect(measured.caption.length).toBeGreaterThan(0);
  // Both rows are 28px — the nav button names `icon-sm` and the caption sits in
  // a `--cell-size` row — so both land on the ladder's 14px for that box.
  for (const glyph of measured.nav) expect(glyph).toBe(14);
  for (const glyph of measured.caption) expect(glyph).toBe(14);
});

test("EmptyStateIcon normalizes the glyph instead of defaulting it", async ({ page }) => {
  const glyphs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="empty-state-icon"]')]
      .map((tile) => tile.querySelector("svg"))
      .filter((svg): svg is SVGElement => svg !== null)
      .map((svg) => ({
        width: Math.round(parseFloat(getComputedStyle(svg).width)),
        selfSized: (svg.getAttribute("class") ?? "").includes("size-"),
      })),
  );

  // The gallery holds both anatomies: a bare icon, and a Spinner that carries
  // its own `size-4`. The tile is the one glyph rule in the kit with no
  // `:not([class*='size-'])` opt-out, so both land on 20px — otherwise the
  // waiting tile would read smaller than the nothing-found tile it stands in
  // for, since Spinner tops out at the 16px `md` step.
  expect(glyphs.some((g) => g.selfSized)).toBe(true);
  expect(glyphs.some((g) => !g.selfSized)).toBe(true);
  for (const glyph of glyphs) expect(glyph.width).toBe(20);
});

test("Alert's icon column tracks the glyph rather than a pinned literal", async ({ page }) => {
  const alerts = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"]')]
      .map((alert) => ({ alert, svg: alert.querySelector(":scope > svg") }))
      .filter((pair): pair is { alert: Element; svg: SVGElement } => pair.svg !== null)
      .map(({ alert, svg }) => ({
        column: getComputedStyle(alert).gridTemplateColumns.split(" ")[0],
        glyph: getComputedStyle(svg).width,
      })),
  );

  expect(alerts.length).toBeGreaterThan(0);
  // The column is `auto`, so a caller who opts the glyph out of the 16px
  // default widens the column with it instead of overflowing one pinned to it.
  for (const alert of alerts) expect(alert.column).toBe(alert.glyph);
});
