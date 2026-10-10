#!/usr/bin/env node
/**
 * extract-secondary-text.mjs — collect every candidate secondary-text string in
 * a frontend package and prescreen it against the mechanical parts of the
 * ruleset. Dependency-free Node ESM.
 *
 * Usage:
 *   node extract-secondary-text.mjs [options]
 *
 *   --root <dir>      package root to scan       (default: packages/web)
 *   --locale <code>   source locale to audit     (default: en)
 *   --scope <substr>  keep only rows whose location or key contains <substr>
 *                     (repeatable — audit one page at a time)
 *   --json            emit JSON instead of the Markdown worksheet
 *   --include-dev     include dev-only surfaces (pages/dev/**), off by default
 *
 * Two carriers are collected, because Rome authors secondary text in both:
 *
 *   locale  — <root>/src/i18n/locales/<locale>/*.json, any leaf key ending in
 *             description / subtitle / hint / helper / helperText. The label is
 *             the sibling title|label|name|heading|header key (or the camelCase
 *             sibling, e.g. emptyDescription -> emptyTitle).
 *   jsx     — literal strings in *Description components and in
 *             description= / subtitle= / hint= / helperText= props.
 *
 * Locale rows are cross-referenced back to the component that renders them, so
 * the placement test has a real location to reason about. Four resolution paths,
 * in order of strength: a t("key") call under the file's useTranslation("ns");
 * an injected t() in a helper with no namespace of its own; a key held as a
 * literal in a config object; a computed key whose literal part still pins the
 * row. Only a row none of them reach is UNRENDERED — dead copy.
 *
 * Prescreen flags are ADVISORY. They mark rows worth reading first; the rules
 * in docs/ui/secondary-text.md decide the verdict. Flags emitted per row:
 *
 *   forbidden:<id>   matches a forbidden opener/pattern (auto-delete in rules)
 *   generic-verb     the only verb is manage/configure/view/set/... on the
 *                    label's own noun
 *   marketing:<word> easily / seamlessly / powerful / simple / quickly
 *   echo:<n>%        share of the text's content words that also appear in the
 *                    label (restatement test, stemmed)
 *   no-signal        no number, unit, condition word, or negation — the text is
 *                    probably description
 *   long:<n>w        more than 25 words; not-prose: 2 words or fewer
 *   sr-only          every call site is visually hidden: an a11y description,
 *                    not secondary text (out of scope, never delete)
 *   label-inferred   no sibling label key — the label shown is guessed from the
 *                    key path and must be checked against the running UI
 *   key-ref:<at>     rendered indirectly through a stored key at <at>
 *   dynamic-key:<at> reached by a computed key at <at>
 *   UNRENDERED       no call site at all
 *   untranslated:<c> no parallel key in locale <c> (deletes and rewrites must
 *                    land in every locale)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const ROOT = opt("root", "packages/web");
const LOCALE = opt("locale", "en");
const AS_JSON = flag("json");
const INCLUDE_DEV = flag("include-dev");
const SCOPES = argv.reduce((acc, a, i) => (a === "--scope" ? [...acc, argv[i + 1]] : acc), []);

// ── ruleset regexes (mechanical half only) ──────────────────────────────────

const FORBIDDEN = [
  {
    id: "this-section",
    re: /\bthis\s+(section|page|panel|tab|view|dialog|card|list)\b[^.]{0,40}\b(allows?|lets?|is used to|is where|contains|shows|displays|provides)\b/i,
  },
  { id: "here-you-can", re: /\bhere\s+you\s+can\b/i },
  { id: "manage-your", re: /\b(manage|configure|customize|control|adjust)\s+(your|the|all)\b/i },
  { id: "view-and-edit", re: /\b(view|see)\s+and\s+(edit|manage|update|change)\b/i },
  { id: "use-this-to", re: /\buse\s+th(is|ese)\s+(to|for)\b/i },
  { id: "allows-you-to", re: /\b(allows?|lets?|enables?)\s+you\s+to\b/i },
  { id: "you-may-want", re: /\byou\s+(may|might)\s+want\s+to\b/i },
];

const MARKETING =
  /\b(easily|seamlessly|effortlessly|powerful|simple|simply|quickly|intuitive|robust)\b/i;

const GENERIC_VERBS =
  /^(manage|configure|view|set|control|adjust|customize|customise|choose|select|edit|update|change|enter|specify|define|pick|browse|see|display|show)\b/i;

const CONDITION =
  /\b(if|when|only|unless|until|after|before|while|except|requires?|must|cannot|can't|won't|never|always|still|first)\b/i;
const NEGATION = /\b(no|not|never|none|without|non|un\w+ed)\b/i;
const NUMBER = /\b\d/;
const UNIT =
  /\b(mb|kb|gb|px|rem|ms|sec|seconds?|minutes?|hours?|days?|weeks?|months?|%|characters?|items?|files?)\b/i;

const STOPWORDS = new Set(
  "a an the this that these those your you our their its it is are be been being to for of on in at by with from and or but as can will would may might do does did not no so than then there here all any each every some new".split(
    " ",
  ),
);

const LABEL_KEYS = ["title", "label", "name", "heading", "header"];

const stem = (w) => w.replace(/(ing|ed|es|s)$/i, "");
const words = (s) =>
  s
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/[^a-z0-9%\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
const contentWords = (s) => words(s).filter((w) => !STOPWORDS.has(w));

function prescreen(text, label) {
  const flags = [];
  for (const f of FORBIDDEN) if (f.re.test(text)) flags.push(`forbidden:${f.id}`);

  const marketing = text.match(MARKETING);
  if (marketing) flags.push(`marketing:${marketing[1].toLowerCase()}`);

  const labelStems = new Set(contentWords(label).map(stem));
  if (GENERIC_VERBS.test(text.trim())) {
    const rest = contentWords(text).slice(1).map(stem);
    const echoesLabel = rest.some((w) => labelStems.has(w));
    if (echoesLabel) flags.push("generic-verb");
  }

  const cw = contentWords(text).map(stem);
  const shared = cw.filter((w) => labelStems.has(w)).length;
  const echo = cw.length ? Math.round((shared / cw.length) * 100) : 0;
  if (echo >= 30) flags.push(`echo:${echo}%`);

  const hasSignal =
    NUMBER.test(text) || UNIT.test(text) || CONDITION.test(text) || NEGATION.test(text);
  if (!hasSignal) flags.push("no-signal");

  const wc = words(text).length;
  if (wc > 25) flags.push(`long:${wc}w`);
  if (wc <= 2) flags.push("not-prose");

  return { flags, echo, words: wc };
}

// ── fs helpers ──────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isDevSurface = (p) => p.split(sep).includes("dev");
const isTest = (p) => /\.(test|spec)\.[tj]sx?$/.test(p);

// ── locale carrier ──────────────────────────────────────────────────────────

const SECONDARY_LEAF = /(^|[a-z])(description|subtitle|hint|helper|helperText|blurb)$/i;

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else if (typeof v === "string") out[key] = v;
  }
  return out;
}

function loadLocale(code) {
  const dir = join(ROOT, "src/i18n/locales", code);
  const byNs = {};
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return byNs;
  }
  for (const f of files) {
    byNs[f.replace(/\.json$/, "")] = flatten(
      JSON.parse(readFileSync(join(dir, f), "utf8")),
      "",
      {},
    );
  }
  return byNs;
}

/** Best-effort label for a secondary-text key: sibling title, camelCase
 *  sibling (emptyDescription -> emptyTitle), then the humanized parent path. */
function findLabel(flat, key) {
  const parts = key.split(".");
  const leaf = parts.at(-1);
  const parent = parts.slice(0, -1).join(".");
  const pfx = parent ? `${parent}.` : "";

  const m = leaf.match(/^(.*?)(Description|Subtitle|Hint|Helper|HelperText|Blurb)$/);
  if (m?.[1]) {
    for (const lk of ["Title", "Label", "Name", "Heading", "Header"]) {
      const cand = `${pfx}${m[1]}${lk}`;
      if (flat[cand]) return { label: flat[cand], from: cand };
    }
    if (flat[`${pfx}${m[1]}`]) return { label: flat[`${pfx}${m[1]}`], from: `${pfx}${m[1]}` };
  }
  for (const lk of LABEL_KEYS) {
    if (flat[`${pfx}${lk}`]) return { label: flat[`${pfx}${lk}`], from: `${pfx}${lk}` };
  }
  const humanized = (parts.at(-2) ?? parts[0] ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
  return { label: humanized, from: "(inferred from key path — verify against the UI)" };
}

// ── jsx carrier + t() call sites ────────────────────────────────────────────

const DESC_COMPONENT = /<([A-Z]\w*(?:Description|Subtitle|Hint))\b([^>]*)>([\s\S]*?)<\/\1>/g;
const DESC_PROP =
  /\b(description|subtitle|hint|helperText)=(?:"([^"]*)"|\{"([^"]*)"\}|\{`([^`{]*)`\})/g;
// `const { t } = useTranslation("settings")`, and the aliased form a file uses
// when it pulls in two namespaces: `const { t: ts } = useTranslation("settings")`.
const NS_BINDING = /\{([^{}]*)\}\s*=\s*useTranslation\(\s*"([^"]+)"/g;
// Key-shaped template literals — `t(`a.${x}.b`)` but also the descriptor form
// (`key: `${base}.subtitle``) that stores a key for a caller to render later.
const KEY_TEMPLATE = /`([\w.]*\$\{[^`]*?\}[\w.${}]*)`/g;
const KEY_SHAPED = /^(?:[\w.]|\$\{[\w.?[\]]+\})+$/;

/** A computed key only earns a dynamic-key match if enough of it is literal —
 *  otherwise its wildcards swallow every key in the file's namespace. A leaf
 *  alone (`${base}.subtitle`) matches every key with that leaf anywhere, so the
 *  prefix consts get substituted first and a still-leaf-only pattern is out. */
function isSpecificEnough(template) {
  const literal = template
    .replace(/\$\{[^}]*\}/g, ".")
    .split(".")
    .filter(Boolean);
  return literal.length >= 1 && literal.join("").length >= 6 && !/^\$\{/.test(template);
}

/** `const base = `connections.cards.${service}`` — one level of substitution,
 *  enough to turn a stored `${base}.subtitle` back into a real key prefix. */
function inlineLocalConsts(template, src) {
  return template.replace(/\$\{(\w+)\}/g, (whole, name) => {
    const m = src.match(new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*\`([^\`]+)\``));
    return m ? m[1] : whole;
  });
}
function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/** Map every local translator binding in a file to its namespace: `t` by
 *  default, plus whatever alias a multi-namespace file gave the second one. */
function translatorsIn(src) {
  const byName = new Map();
  for (const m of src.matchAll(NS_BINDING)) {
    for (const part of m[1].split(",")) {
      const [name, alias] = part.split(":").map((s) => s.trim());
      if (name === "t") byName.set(alias || "t", m[2]);
    }
  }
  return byName;
}

function scanSources() {
  const files = walk(join(ROOT, "src")).filter(
    (p) => /\.[jt]sx?$/.test(p) && !isTest(p) && (INCLUDE_DEV || !isDevSurface(p)),
  );
  const jsxRows = [];
  const callSites = new Map(); // "ns.key" -> [{ at, srOnly }, ...]
  const dynamicKeys = []; // regexes over key paths a computed key may reach
  // Store modules and helpers call an injected t() with no useTranslation of
  // their own, so their keys carry no namespace and resolve by key alone.
  const unscopedKeys = new Map();
  // A key held in a config object (`descriptionKey: "aiTools.x.description"`)
  // and rendered elsewhere is still live copy, just not at a call site.
  const keyRefs = new Map();

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = relative(process.cwd(), file);
    const translators = translatorsIn(src);
    const lines = src.split("\n");

    for (const m of src.matchAll(/\b(\w+)\(\s*"([^"]+)"/g)) {
      const [, fn, key] = m;
      const ns = translators.get(fn);
      // A helper module calls an injected t() it never bound itself; its keys
      // carry no namespace and resolve by key alone.
      if (!ns && !(fn === "t" && translators.size === 0)) continue;
      const line = lineOf(src, m.index);
      if (!ns) {
        if (!unscopedKeys.has(key)) unscopedKeys.set(key, []);
        unscopedKeys.get(key).push(`${rel}:${line}`);
        continue;
      }
      // A key reached through a visually-hidden wrapper renders as an a11y
      // description, not as secondary text; the wrapper is usually the opening
      // tag one or two lines up.
      const srOnly = lines.slice(Math.max(0, line - 3), line).some((l) => l.includes("sr-only"));
      const id = `${ns}.${key}`;
      if (!callSites.has(id)) callSites.set(id, []);
      callSites.get(id).push({ at: `${rel}:${line}`, srOnly });
    }

    for (const m of src.matchAll(/"(\w+(?:\.\w+)+)"/g)) {
      const key = m[1];
      if (!keyRefs.has(key)) keyRefs.set(key, []);
      keyRefs.get(key).push(`${rel}:${lineOf(src, m.index)}`);
    }

    for (const m of src.matchAll(KEY_TEMPLATE)) {
      if (!KEY_SHAPED.test(m[1])) continue;
      const resolved = inlineLocalConsts(m[1], src);
      if (!isSpecificEnough(resolved)) continue;
      const pattern = resolved
        .replace(/[.*+?^$()[\]{}|\\]/g, "\\$&")
        .replace(/\\\$\\\{[^}]*?\\\}/g, "[\\w.]+");
      dynamicKeys.push({
        re: new RegExp(`(^|\\.)${pattern}$`),
        at: `${rel}:${lineOf(src, m.index)}`,
      });
    }

    for (const m of src.matchAll(DESC_COMPONENT)) {
      const [, tag, attrs, inner] = m;
      const text = inner.trim();
      if (!text || text.includes("{") || text.includes("<")) continue; // dynamic
      jsxRows.push({
        carrier: tag,
        location: `${rel}:${lineOf(src, m.index)}`,
        text,
        srOnly: /sr-only/.test(attrs),
      });
    }

    for (const m of src.matchAll(DESC_PROP)) {
      const text = (m[2] ?? m[3] ?? m[4] ?? "").trim();
      if (!text) continue;
      jsxRows.push({
        carrier: `${m[1]}=`,
        location: `${rel}:${lineOf(src, m.index)}`,
        text,
        srOnly: false,
      });
    }
  }
  return { jsxRows, callSites, dynamicKeys, unscopedKeys, keyRefs };
}

// ── build rows ──────────────────────────────────────────────────────────────

const source = loadLocale(LOCALE);
const otherLocales = (() => {
  const dir = join(ROOT, "src/i18n/locales");
  try {
    return readdirSync(dir).filter((c) => c !== LOCALE);
  } catch {
    return [];
  }
})();
const others = Object.fromEntries(otherLocales.map((c) => [c, loadLocale(c)]));
const { jsxRows, callSites, dynamicKeys, unscopedKeys, keyRefs } = scanSources();

const rows = [];

for (const [ns, flat] of Object.entries(source)) {
  for (const [key, text] of Object.entries(flat)) {
    if (!SECONDARY_LEAF.test(key.split(".").at(-1))) continue;
    const id = `${ns}.${key}`;
    const { label, from } = findLabel(flat, key);
    const sites = [
      ...(callSites.get(id) ?? []),
      ...(unscopedKeys.get(key) ?? []).map((at) => ({ at, srOnly: false })),
    ];
    const { flags, echo, words: wc } = prescreen(text, label);

    if (!sites.length) {
      const ref = keyRefs.get(key)?.[0];
      const dynamic = dynamicKeys.find((d) => d.re.test(id));
      if (ref) flags.push(`key-ref:${ref}`);
      else if (dynamic) flags.push(`dynamic-key:${dynamic.at}`);
      else flags.push("UNRENDERED");
    }
    if (sites.length && sites.every((s) => s.srOnly)) flags.unshift("sr-only");
    if (from.startsWith("(inferred")) flags.push("label-inferred");
    for (const c of otherLocales) if (!others[c]?.[ns]?.[key]) flags.push(`untranslated:${c}`);

    rows.push({
      carrier: "locale",
      key: id,
      location: sites[0]?.at ?? `${ROOT}/src/i18n/locales/${LOCALE}/${ns}.json`,
      allSites: sites.map((s) => s.at),
      label,
      labelFrom: from,
      text,
      flags,
      echo,
      words: wc,
    });
  }
}

for (const r of jsxRows) {
  const { flags, echo, words: wc } = prescreen(r.text, "");
  if (r.srOnly) flags.unshift("sr-only");
  rows.push({
    carrier: r.carrier,
    key: "",
    location: r.location,
    allSites: [r.location],
    label: "(read the sibling title in the JSX)",
    labelFrom: "",
    text: r.text,
    flags,
    echo,
    words: wc,
  });
}

const scoped = SCOPES.length
  ? rows.filter((r) => SCOPES.some((s) => r.key.includes(s) || r.location.includes(s)))
  : rows;

scoped.sort((a, b) => (a.key || a.location).localeCompare(b.key || b.location));

// ── output ──────────────────────────────────────────────────────────────────

if (AS_JSON) {
  console.log(
    JSON.stringify({ root: ROOT, locale: LOCALE, count: scoped.length, rows: scoped }, null, 2),
  );
  process.exit(0);
}

const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const auto = scoped.filter((r) =>
  r.flags.some((f) => f.startsWith("forbidden:") || f === "generic-verb"),
);
const srOnly = scoped.filter((r) => r.flags.includes("sr-only"));
const unrendered = scoped.filter((r) => r.flags.includes("UNRENDERED"));

console.log(`# Secondary-text candidates — ${ROOT} (${LOCALE})\n`);
console.log(`${scoped.length} candidates${SCOPES.length ? ` in scope ${SCOPES.join(", ")}` : ""}.`);
console.log(
  `${auto.length} match a forbidden pattern, ${scoped.filter((r) => r.flags.includes("no-signal")).length} carry no signal word, ` +
    `${unrendered.length} have no call site, ${srOnly.length} are sr-only (out of scope).\n`,
);
console.log("Flags are advisory. Apply docs/ui/secondary-text.md to reach a verdict.\n");
console.log("| Location | Label | Secondary text | Flags |");
console.log("|---|---|---|---|");
for (const r of scoped) {
  const loc = r.key ? `\`${r.key}\`<br>${r.location}` : `\`${r.carrier}\`<br>${r.location}`;
  console.log(`| ${esc(loc)} | ${esc(r.label)} | ${esc(r.text)} | ${r.flags.join(" ") || "—"} |`);
}
