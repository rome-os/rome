import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  baselineKey,
  classifyCandidate,
  classifyCss,
  findViolations,
  loadDesignSystem,
  readRosters,
  repoRoot,
  scanRoots,
  stringLiterals,
} from "./check-utility-tokens.mjs";
import { baselineCounts } from "./utility-tokens-baseline.mjs";

const violations = await findViolations();

/** Live occurrences per file and class, to compare against the quarantined count. */
const liveCounts = new Map();
for (const violation of violations) {
  const key = baselineKey(violation);
  liveCounts.set(key, (liveCounts.get(key) ?? 0) + 1);
}

/** Compiles candidates the way the gate does, so a test can assert on one class. */
const designSystem = await loadDesignSystem();
const rosters = await readRosters();
const reasonFor = (candidates) => {
  const compiled = designSystem.candidatesToCss(candidates);
  return candidates.map((candidate, index) =>
    classifyCandidate(candidate, compiled[index], rosters),
  );
};

test("every utility class names a token the design system owns", () => {
  const over = [...liveCounts]
    .filter(([key, count]) => count > (baselineCounts.get(key) ?? 0))
    .map(([key, count]) => `${key}  (${count} now, ${baselineCounts.get(key) ?? 0} quarantined)`);

  assert.deepEqual(
    over,
    [],
    "Off-system utility class: this compiles to a raw value, not a Rome token.\n" +
      "Use a spacing step (gap-2), a typography role (text-ui), or a color token\n" +
      "(text-muted-foreground). If none fits, the value belongs in a named token —\n" +
      "add it to the canon and reference it here.",
  );
});

test("the baseline holds no entry that has already been fixed", () => {
  const stale = [...baselineCounts]
    .filter(([key, count]) => (liveCounts.get(key) ?? 0) < count)
    .map(([key, count]) => `${key}  (${liveCounts.get(key) ?? 0} now, ${count} quarantined)`);

  assert.deepEqual(
    stale,
    [],
    "Fixed classes still quarantined in utility-tokens-baseline.mjs — lower the count,\n" +
      "or delete the entry once it reaches zero.",
  );
});

test("scans the kit, the dashboard, and every first-party app web bundle", () => {
  const { fixed, apps } = scanRoots();

  // The kit, the dashboard, the SDK runtime, and the two app scaffolds.
  assert.equal(fixed.length, 5);
  // A gate that scans nothing passes, so narrowed coverage has to fail here.
  assert.ok(apps.length >= 5, `expected first-party app web bundles, found ${apps.length}`);
  assert.ok(violations.length > 0, "scanned every root and found nothing — the scan is broken");
});

test("reports off-roster utilities in vendored app web sources only", async (t) => {
  const appWeb = mkdtempSync(join(tmpdir(), "rome-utility-token-vendor-"));
  const vendoredSource = join(appWeb, "vendor", "example.tsx");
  mkdirSync(join(appWeb, "vendor"));
  writeFileSync(vendoredSource, 'export const Example = () => <span className="text-2xs" />;\n');
  t.after(() => rmSync(appWeb, { recursive: true, force: true }));

  const appViolations = await findViolations(repoRoot, { fixed: [], apps: [appWeb] });
  assert.deepEqual(
    appViolations.map(({ value, reason }) => ({ value, reason })),
    [{ value: "text-2xs", reason: "stock text size" }],
  );

  const fixedViolations = await findViolations(repoRoot, { fixed: [appWeb], apps: [] });
  assert.deepEqual(fixedViolations, [], "vendor directories outside app web sources stay skipped");
});

test("compiles a candidate through the dashboard's own theme", () => {
  // The whole gate rests on this binding. Were the entry stylesheet to fail to
  // load, every class would compile against Tailwind's stock theme and invert.
  const [onRoster, offRoster, romeColor] = designSystem.candidatesToCss([
    "gap-2",
    "gap-1.5",
    "bg-primary",
  ]);

  assert.match(onRoster, /gap:\s*var\(--rome-space-2\)/);
  assert.match(offRoster, /gap:\s*calc\(var\(--spacing\)\s*\*\s*1\.5\)/);
  assert.match(romeColor, /background-color:\s*var\(--primary\)/);
});

test("keeps denied candidates visible to the source gate", () => {
  const denied = [
    ["p-1.5", "off-scale spacing"],
    ["px-1.5", "off-scale spacing"],
    ["py-0.5", "off-scale spacing"],
    ["text-2xs", "stock text size"],
    ["rounded", "arbitrary radius"],
    ["rounded-md", "legacy radius ladder"],
    ["rounded-lg", "legacy radius ladder"],
    ["rounded-xl", "legacy radius ladder"],
  ];
  const candidates = denied.map(([candidate]) => candidate);
  const compiled = designSystem.candidatesToCss(candidates);

  assert.deepEqual(
    compiled,
    candidates.map(() => null),
    "the stylesheet should keep dependency candidates out of bundles",
  );
  assert.deepEqual(
    reasonFor(candidates),
    denied.map(([, reason]) => reason),
  );
});

test("reads the sanctioned rosters out of the canon", async () => {
  const { roles, primitives, spacing } = await readRosters();

  assert.deepEqual([...roles].sort(), [
    "aux",
    "badge",
    "composer",
    "display",
    "section",
    "title",
    "ui",
  ]);
  for (const token of ["--neutral-500", "--red-500"]) {
    assert.ok(primitives.has(token), `primitive roster is missing ${token}`);
  }
  // The sanctioned utilities compile to the spacing steps, so counting them as
  // unreadable primitives would mark `gap-2` a violation.
  assert.ok(!primitives.has("--rome-space-2"), "spacing steps must not count as primitives");
  assert.deepEqual([...spacing], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24]);
});

test("finds class strings in every form a class list is written in", () => {
  const sources = {
    "plain attribute": '<div className="gap-1.5" />',
    ternary: '<div className={ok ? "gap-1.5" : "gap-2"} />',
    concatenation: '<div className={"gap-1.5 " + (ok ? "a" : "b")} />',
    "template literal": "<div className={`gap-1.5 ${extra}`} />",
    "helper call": '<div className={cn("gap-1.5", other)} />',
    "cva variant object": 'cva("base", { variants: { size: { sm: "gap-1.5" } } })',
    // A lookup table reaches the DOM through a `className={x}` elsewhere, so the
    // literal is all this scan ever sees.
    "lookup table": 'const BADGES = { telegram: { badge: "gap-1.5 text-white" } };',
  };

  // A class list inside an HTML string arrives with the markup attached.
  sources["embedded markup"] = "const markup = '<div class=\"gap-1.5 bg-white\">';";

  for (const [form, code] of Object.entries(sources)) {
    const classes = stringLiterals(code).flatMap((literal) => literal.text.split(/[\s"'`<>]+/));
    assert.ok(classes.includes("gap-1.5"), `${form}: gap-1.5 went unseen`);
  }
});

test("judges a class by the declaration it compiles to", () => {
  const compliant = [
    "gap-2",
    "p-4",
    "mt-24",
    "text-ui",
    "text-aux",
    "bg-primary",
    "text-muted-foreground",
    "border-destructive/50",
    // Token reads and arithmetic over them track the token.
    "px-[var(--field-px-md)]",
    "pr-[calc(var(--field-px-md)-4px)]",
    // A name this repo never declares may be Radix's or an app's.
    "h-[var(--radix-select-trigger-height)]",
    // Sizing reads the spacing namespace but is not a spacing property.
    "w-96",
    "size-4",
    "max-h-64",
    // The box size scale binds 11 and 14 on the shared delivery namespace, so
    // these steps resolve to `--rome-size-*` and carry a token to retune.
    "ml-14",
    "sm:py-14",
    "scroll-pb-11",
    // Keywords, hairlines, and the zero step are not rhythm.
    "mx-auto",
    "gap-px",
    "pb-safe",
    "sr-only",
    // `text-` is shared with alignment, which compiles to no font-size.
    "text-center",
    "text-balance",
    // Widths and gradient stops, not paint.
    "border-2",
    "border-[2px]",
    "from-[20%]",
    // Paint that carries no color.
    "bg-none",
    "bg-linear-to-r",
    // Gradient paint resolves through `--tw-gradient-stops`, set by the stop
    // utilities, which classify on their own.
    "bg-gradient-to-r",
    // Tailwind writes its own literal fallbacks into composites, and the
    // forced-colors outline, so neither reads as an authored value.
    "shadow-md",
    "outline-hidden",
    "bg-transparent",
    "fill-current",
    "fill-[url(#gradient)]",
    // An arbitrary padding literal belongs to check-padding-scale.mjs.
    "pl-[38px]",
    // The radius roster: the numbered steps, saturation, and zero. Zero strips
    // seams and is not a scale value, so its directional variants pass too.
    "rounded-4",
    "rounded-8",
    "rounded-t-8",
    "rounded-s-4",
    "rounded-full",
    "rounded-tl-full",
    "rounded-e-full",
    "sm:rounded-8",
    "rounded-none",
    "rounded-t-none",
    "rounded-ss-none",
    // Bracket-form reads of a radius token track the token.
    "rounded-[var(--rome-radius-8)]",
    "rounded-[var(--control-r-md)]",
    "rounded-(--control-r-md)",
  ];
  for (const [index, reason] of reasonFor(compliant).entries()) {
    assert.equal(reason, null, compliant[index]);
  }

  const offSystem = [
    ["gap-1.5", "off-scale spacing"],
    ["mt-0.5", "off-scale spacing"],
    // 13 is no spacing step and no named size binding, so it stays on the
    // multiplier. 11 and 14 resolve to `--rome-size-*` since the box size
    // scale bound them, so they classify clean and sit in `compliant` above.
    ["ml-13", "off-scale spacing"],
    ["sm:gap-1.5", "off-scale spacing"],
    ["*:data-[slot=x]:gap-1.5", "off-scale spacing"],
    ["mr-[5px]", "arbitrary spacing"],
    // A calculation over literals has no token behind it to retune.
    ["gap-[calc(5px+1px)]", "arbitrary spacing"],
    ["text-sm", "stock text size"],
    ["md:text-2xl", "stock text size"],
    ["[&_h1]:text-base", "stock text size"],
    ["text-[10px]", "arbitrary font size"],
    ["text-[2.65rem]", "arbitrary font size"],
    // Paint is judged by the value, so a syntax no rule here names still lands.
    ["text-[#d97757]", "arbitrary color"],
    ["bg-[red]", "arbitrary color"],
    ["bg-[hwb(210_20%_30%)]", "arbitrary color"],
    ["bg-[lab(50%_40_59)]", "arbitrary color"],
    ["bg-[color(display-p3_1_0_0)]", "arbitrary color"],
    // Tailwind's own palette stays in its `--color-*` namespace.
    ["bg-red-500", "stock palette color"],
    ["dark:text-amber-400", "stock palette color"],
    ["via-amber-200/50", "stock palette color"],
    ["border-t-gray-800", "stock palette color"],
    ["bg-white", "stock palette color"],
    ["ring-black/5", "stock palette color"],
    // Reading the raw layer from a component breaks the aliasing direction.
    ["bg-[var(--neutral-500)]", "primitive token read"],
    // A fallback renders whenever the name is undeclared, so a literal one puts
    // a raw value on the page behind a reference that looks like a token read.
    ["gap-[var(--missing,6px)]", "arbitrary spacing"],
    ["bg-[var(--missing,red)]", "arbitrary color"],
    // A gradient carries its stops inline.
    ["bg-[linear-gradient(red,blue)]", "arbitrary color"],
    // Tailwind wraps authored paint in an alpha channel, which is no token.
    ["shadow-[#fff]", "arbitrary color"],
    ["inset-shadow-[#fff]", "arbitrary color"],
    ["text-shadow-red-500", "stock palette color"],
    ["text-[length:var(--missing,10px)]", "arbitrary font size"],
    // The legacy ladder resolves through the shadcn `--radius` contract, not
    // the roster. Bare `rounded` compiles to a literal, so it lands there.
    ["rounded-sm", "legacy radius ladder"],
    ["rounded-md", "legacy radius ladder"],
    ["rounded-lg", "legacy radius ladder"],
    ["rounded-xl", "legacy radius ladder"],
    ["rounded-2xl", "legacy radius ladder"],
    ["rounded-l-lg", "legacy radius ladder"],
    ["sm:rounded-lg", "legacy radius ladder"],
    ["rounded", "arbitrary radius"],
    // A literal corner, including the near-full one `rounded-full` exists to
    // replace, has no token behind it to retune.
    ["rounded-[7px]", "arbitrary radius"],
    ["rounded-[13px]", "arbitrary radius"],
    ["rounded-[2rem]", "arbitrary radius"],
    ["rounded-[50%]", "arbitrary radius"],
    ["rounded-[9999px]", "arbitrary radius"],
    ["rounded-b-[6px]", "arbitrary radius"],
    ["rounded-[var(--missing,6px)]", "arbitrary radius"],
    // Derivation happens once, in the scale — arithmetic over a step is not a
    // clean token read, and a name outside the roster is not a radius token.
    ["rounded-[calc(var(--rome-radius-8)+1px)]", "off-roster radius token"],
    ["rounded-[var(--radix-popover-content-radius)]", "off-roster radius token"],
    // The scale is closed, so an invented name cannot ride the namespace in.
    ["rounded-[var(--rome-radius-24)]", "off-roster radius token"],
    ["rounded-[var(--control-r-xl)]", "off-roster radius token"],
  ];
  for (const [index, reason] of reasonFor(offSystem.map(([cls]) => cls)).entries()) {
    assert.equal(reason, offSystem[index][1], offSystem[index][0]);
  }
});
