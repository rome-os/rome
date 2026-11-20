import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { evaluateConstraints } from "./measure.js";
import type { Constraint, Finding } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Every `*.constraints.json` beside this file, in one list. */
export function loadConstraints(dir = here): Constraint[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".constraints.json"))
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Constraint[]);
}

export async function checkConstraints(page: Page, constraints: Constraint[]): Promise<Finding[]> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(evaluateConstraints, constraints);
}

/**
 * A screenshot of the finding's region with each measured rect outlined and a
 * guide line at the median value, so a reader sees which box sits off the line
 * and by how much. The region may sit outside the viewport or inside a scrolled
 * pane, so the first offending element is scrolled to the middle, and the
 * constraint is measured again there: a virtualized list can re-lay itself out
 * on scroll, so shifting the old rects would draw them in the wrong place.
 */
export async function cropFinding(
  page: Page,
  original: Finding,
  constraint: Constraint,
): Promise<Buffer | null> {
  const anchorOf = (f: Finding) => {
    if (f.kind === "stale") return f.ref;
    const median = medianOf(f);
    return (f.measured.find((m) => Math.abs(m.value - median) > 0.5) ?? f.measured[0]).ref;
  };
  await page.evaluate(async (ref) => {
    const el = (window as unknown as { __layoutConstraintRefs: Element[] }).__layoutConstraintRefs[
      ref
    ];
    el?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    // Wait until the element stops moving, for smooth scrolling and late layout.
    let last = Number.NaN;
    for (let i = 0; i < 30; i++) {
      await new Promise(requestAnimationFrame);
      const top = el?.getBoundingClientRect().top ?? 0;
      if (top === last) break;
      last = top;
    }
  }, anchorOf(original));
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const again = (await page.evaluate(evaluateConstraints, [constraint])).filter(
    (f) => f.kind === original.kind && sameLabels(f, original),
  );
  const finding = again
    .map((f) => {
      const r = rectsOf(f).find((m) => m.off)?.rect ?? rectsOf(f)[0].rect;
      return { f, d: Math.abs((r.top + r.bottom) / 2 - vp.height / 2) };
    })
    .sort((x, y) => x.d - y.d)[0]?.f;
  if (!finding) return null;

  const rects = rectsOf(finding);
  const median = medianOf(finding);
  const edge =
    finding.kind === "violation" ? (finding.measured[0].label.split(".").at(-1) ?? "") : "";
  const guide =
    finding.kind !== "violation"
      ? null
      : /left|right|centerX/.test(edge)
        ? { vertical: true, value: median }
        : /top|bottom|centerY/.test(edge)
          ? { vertical: false, value: median }
          : null;

  const pad = 24;
  const left = Math.max(0, Math.min(...rects.map((r) => r.rect.left)) - pad);
  const top = Math.max(0, Math.min(...rects.map((r) => r.rect.top)) - pad);
  const right = Math.min(vp.width, Math.max(...rects.map((r) => r.rect.right)) + pad);
  const bottom = Math.min(vp.height, Math.max(...rects.map((r) => r.rect.bottom)) + pad);
  if (right - left < 1 || bottom - top < 1) return null;

  await page.evaluate(
    ({ rects, guide }) => {
      const layer = document.createElement("div");
      layer.id = "__layout-constraint-overlay";
      layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      for (const { rect, label, off } of rects) {
        const b = document.createElement("div");
        const color = off ? "#e11d48" : "#16a34a";
        b.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.right - rect.left}px;height:${rect.bottom - rect.top}px;outline:1px solid ${color};`;
        const t = document.createElement("span");
        t.textContent = label;
        t.style.cssText = `position:absolute;top:-14px;left:0;font:10px monospace;color:#fff;background:${color};padding:0 2px;white-space:nowrap`;
        b.append(t);
        layer.append(b);
      }
      if (guide) {
        const g = document.createElement("div");
        g.style.cssText = guide.vertical
          ? `position:absolute;top:0;bottom:0;left:${guide.value}px;border-left:1px dashed #2563eb`
          : `position:absolute;left:0;right:0;top:${guide.value}px;border-top:1px dashed #2563eb`;
        layer.append(g);
      }
      document.body.append(layer);
    },
    { rects, guide },
  );
  try {
    return await page.screenshot({
      clip: { x: left, y: top, width: right - left, height: bottom - top },
    });
  } finally {
    await page.evaluate(() => document.getElementById("__layout-constraint-overlay")?.remove());
  }
}

export function formatFinding(f: Finding): string {
  if (f.kind === "stale") return `[stale] ${f.id}: ${f.detail}`;
  const rows = f.measured
    .map((m) => `    ${m.value.toFixed(1).padStart(7)}  ${m.label}`)
    .join("\n");
  return `[violation] ${f.id}: spread ${f.spread.toFixed(1)}px\n    why: ${f.why}\n${rows}`;
}

function medianOf(f: Finding): number {
  if (f.kind === "stale") return 0;
  const sorted = f.measured.map((m) => m.value).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function rectsOf(f: Finding) {
  if (f.kind === "stale") return [{ rect: f.scopeRect, label: "stale scope", off: true }];
  const median = medianOf(f);
  return f.measured.map((m) => ({
    rect: m.rect,
    label: m.value.toFixed(1),
    off: Math.abs(m.value - median) > 0.5,
  }));
}

function sameLabels(a: Finding, b: Finding): boolean {
  if (a.kind === "stale" || b.kind === "stale") return a.kind === b.kind && a.id === b.id;
  return (
    a.id === b.id && a.measured.map((m) => m.label).join() === b.measured.map((m) => m.label).join()
  );
}
