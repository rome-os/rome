// PROTOTYPE — screenshots and measurements of every phone redesign variant on
// every surveyed route, at 390x844 with touch, against a running mock server.
//
//   pnpm --filter rome-web dev:mock          # in one shell (unset NODE_ENV)
//   node packages/web/mock/capture-phone-variants.prototype.mjs [outDir]
//
// Writes <outDir>/<variant>-<route>.png, one side-by-side sheet per route
// (sheet-<route>.png), and metrics.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://localhost:3200";
const OUT = resolve(process.argv[2] ?? "phone-variants");
const VARIANTS = ["a", "b", "c"];
const SHOTS = [
  { key: "chat", path: "/chat/mock-chat-build-app", ready: '[data-streamdown="mermaid"] button' },
  { key: "activity", path: "/activity" },
  { key: "routines", path: "/routines" },
  { key: "settings", path: "/settings" },
  { key: "settings-connections", path: "/settings/connections" },
  { key: "nav", path: "/chat", nav: true },
];

mkdirSync(OUT, { recursive: true });

// Serialized into the page.
function measure() {
  const vw = innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const label = (el) =>
    (el.getAttribute("aria-label") || el.textContent || el.tagName)
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 30);
  const controls = [
    ...document.querySelectorAll(
      "button, a[href], summary, select, [role=button], [role=tab], [role=switch], [role=radio]",
    ),
  ].filter(
    (el) =>
      visible(el) &&
      !el.closest("[inert], [aria-hidden=true], [data-prototype-switcher]") &&
      !el.disabled &&
      getComputedStyle(el).pointerEvents !== "none" &&
      !(el.tagName !== "SUMMARY" && el.closest("details:not([open])")),
  );
  const small = [];
  const stolen = [];
  for (const el of controls) {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    if (r.right <= 0 || r.left >= vw) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const own = (x, y) => {
      const hit = document.elementFromPoint(
        Math.min(Math.max(x, 0.5), vw - 0.5),
        Math.min(Math.max(y, 0.5), innerHeight - 0.5),
      );
      return hit && (hit === el || el.contains(hit));
    };
    const inline =
      el.tagName === "A" &&
      getComputedStyle(el).display === "inline" &&
      [...el.parentElement.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (
      !inline &&
      ![
        [0, 0],
        [-21, 0],
        [21, 0],
        [0, -21],
        [0, 21],
      ].every(([dx, dy]) => own(cx + dx, cy + dy))
    ) {
      small.push(`${Math.round(r.width)}x${Math.round(r.height)} ${label(el)}`);
    }
    const hw = Math.max(r.width / 2 - 2, 0);
    const hh = Math.max(r.height / 2 - 2, 0);
    if (
      !inline &&
      ![
        [0, 0],
        [-hw, 0],
        [hw, 0],
        [0, -hh],
        [0, hh],
      ].every(([dx, dy]) => own(cx + dx, cy + dy))
    ) {
      stolen.push(`${Math.round(r.width)}x${Math.round(r.height)} ${label(el)}`);
    }
  }
  scrollTo(0, 0);

  // Rendered text sizes, weighted by visible characters.
  const sizes = {};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    const el = node.parentElement;
    if (!text || !el || !visible(el) || el.closest("[data-prototype-switcher], script, style"))
      continue;
    const px = Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10;
    sizes[px] = (sizes[px] ?? 0) + text.length;
  }

  // Scrolled to the end, anything interactive still under C's tab bar.
  const bar = document.querySelector('nav[aria-label="Tabs"]');
  let underBar = [];
  if (bar && visible(bar)) {
    scrollTo(0, document.documentElement.scrollHeight);
    const top = bar.getBoundingClientRect().top;
    underBar = controls
      .filter((el) => !bar.contains(el))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.bottom > top + 1 && r.top < innerHeight && getComputedStyle(el).position !== "fixed"
        );
      })
      .map(label);
    scrollTo(0, 0);
  }
  // Labels cut off with an ellipsis or clipped by their own box.
  const truncated = [...document.querySelectorAll("body *")].filter((el) => {
    if (!visible(el) || el.closest("[data-prototype-switcher]")) return false;
    const s = getComputedStyle(el);
    return (
      (s.textOverflow === "ellipsis" || s.overflow === "hidden") &&
      el.scrollWidth > el.clientWidth + 1 &&
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    );
  }).length;
  // Painted heights of the kit's labelled and square controls.
  const heights = [
    ...document.querySelectorAll(
      '[data-slot="button"], [data-slot="icon-button"], [data-slot="select-trigger"], [data-slot="segmented-control-item"], [data-slot="filter-chip"]',
    ),
  ]
    .filter(visible)
    .map((el) => Math.round(el.getBoundingClientRect().height))
    .sort((x, y) => x - y);
  const composer = document.querySelector("[data-chat-composer-box]");
  return {
    truncatedLabels: truncated,
    controlHeights: heights.length
      ? {
          min: heights[0],
          median: heights[Math.floor(heights.length / 2)],
          max: heights.at(-1),
          n: heights.length,
        }
      : null,
    overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw,
    under44: small,
    ownBoxTaken: stolen,
    textPx: sizes,
    composerBottom: composer ? Math.round(composer.getBoundingClientRect().bottom) : null,
    tabBarTop: bar && visible(bar) ? Math.round(bar.getBoundingClientRect().top) : null,
    controlsUnderTabBarAtRest: underBar.slice(0, 10),
  };
}

const browser = await chromium.launch();
const metrics = {};
for (const variant of VARIANTS) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  for (const shot of SHOTS) {
    const page = await context.newPage();
    await page.goto(`${BASE}${shot.path}?variant=${variant}&switcher=0`);
    await page.locator("button").filter({ visible: true }).first().waitFor({ timeout: 60_000 });
    if (shot.ready)
      await page
        .locator(shot.ready)
        .first()
        .waitFor({ timeout: 60_000 })
        .catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    if (shot.nav) {
      const opener =
        variant === "c"
          ? page.locator('nav[aria-label="Tabs"] button')
          : page.getByRole("button", { name: "Open sidebar" });
      await opener.click();
      await page.waitForTimeout(600);
    }
    const name = `${variant}-${shot.key}`;
    if (!shot.nav) metrics[name] = await page.evaluate(measure);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    await page.close();
  }
  await context.close();
}

// One sheet per route: A | B | C side by side, at phone scale.
const sheet = await browser.newPage({ viewport: { width: 1290, height: 960 } });
for (const shot of SHOTS) {
  const cells = VARIANTS.map(
    (v) =>
      `<figure><figcaption>${v.toUpperCase()}</figcaption><img src="data:image/png;base64,${readFileSync(join(OUT, `${v}-${shot.key}.png`)).toString("base64")}"></figure>`,
  ).join("");
  await sheet.setContent(
    `<style>body{margin:0;display:flex;gap:30px;padding:20px;background:#eee;font:600 20px system-ui}figure{margin:0}img{width:390px;height:844px;border:1px solid #999}figcaption{margin-bottom:8px}</style>${cells}`,
  );
  await sheet.waitForTimeout(300);
  await sheet.screenshot({ path: join(OUT, `sheet-${shot.key}.png`) });
}

writeFileSync(join(OUT, "metrics.json"), JSON.stringify(metrics, null, 1));
await browser.close();
console.log(`wrote ${OUT}`);
