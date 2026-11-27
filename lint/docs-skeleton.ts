#!/usr/bin/env tsx
/**
 * Lists the gaps in the docs skeleton: the short set of docs that states what
 * Rome should be, which the code cannot state.
 *
 * The skeleton is the purpose, the "never" list, how concepts work together,
 * one entry per concept, and the list of parts with each part's `AGENTS.md`.
 * The list of parts covers every folder of code: a folder is a part, sits
 * inside a part, or is named under "Not parts".
 * A concept entry and a part's `AGENTS.md` carry their content in fields: a
 * paragraph that opens with a bold label such as `**Purpose.**`.
 *
 * Every gap is either listed in `docs-skeleton-gaps.ts` or fails the check, and
 * a listed gap that is closed fails too, so the list only shrinks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_GAPS } from "./docs-skeleton-gaps.js";

const TARGET = "docs/target";
const PARTS = `${TARGET}/parts.md`;
const CONCEPTS = `${TARGET}/concepts`;
const WHOLE_PRODUCT = [`${TARGET}/purpose.md`, `${TARGET}/never.md`, `${TARGET}/together.md`];
const PART_FIELDS = ["Question", "Promises", "May use"];
const CONCEPT_FIELDS = ["Purpose", "Story", "Carried by"];
/** Every folder directly under one of these is a part, sits inside a part, or is named under "Not parts". */
const CODE_ROOTS = ["packages", "packages/core/src"];
const NOT_PARTS = /^#{1,6}\s+Not parts\s*$/;

function read(root: string, file: string): string | null {
  const full = path.join(root, file);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
}

/** The text of a doc without its HTML comments. A comment that never closes runs to the end of the doc. */
function withoutComments(text: string): string {
  let shown = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open === -1) return shown + text.slice(at);
    shown += text.slice(at, open);
    const close = text.indexOf("-->", open + 4);
    if (close === -1) return shown;
    at = close + 3;
  }
}

/**
 * The lines of a doc that a reader sees as prose. A comment is a note to the
 * writer, and a fenced code block is an example that may hold a label or a
 * link, so neither counts. A block closes on a fence of the same character
 * that is at least as long as the one that opened it.
 */
function proseLines(text: string): string[] {
  let open: string | null = null;
  return withoutComments(text)
    .split("\n")
    .filter((line) => {
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (open === null) {
        if (fence) open = fence[1];
        return !fence;
      }
      const closes =
        fence?.[1][0] === open[0] && fence[1].length >= open.length && !fence[2].trim();
      if (closes) open = null;
      return false;
    });
}

/** Each field of a doc by its label. A field runs to the next field or heading. */
function fieldsOf(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  let current: string | null = null;
  for (const line of proseLines(text)) {
    const label = /^\*\*([^*]+?)\.\*\*\s*(.*)$/.exec(line);
    if (label) {
      current = label[1];
      fields.set(current, label[2]);
    } else if (/^#{1,6}\s/.test(line)) {
      current = null;
    } else if (current !== null) {
      fields.set(current, `${fields.get(current)}\n${line}`);
    }
  }
  return fields;
}

/**
 * The repo-relative files a doc links to. A target that opens with `/` starts
 * at the repo root. A link to a URL or to a place in the same doc is left out.
 */
function linkedFiles(file: string, text: string): string[] {
  const links = proseLines(text)
    .join("\n")
    .matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g);
  return [...links]
    .map((link) => link[1])
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .map((target) =>
      target.startsWith("/")
        ? path.posix.normalize(target.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), target)),
    );
}

function missingFields(file: string, text: string, names: string[]): string[] {
  const fields = fieldsOf(text);
  return names.filter((name) => !fields.get(name)?.trim()).map((name) => `${file}: no "${name}"`);
}

/** The gaps of the parts list and of each listed part, and the `AGENTS.md` of every part that has one. */
function partGaps(root: string): { gaps: string[]; parts: Set<string> } {
  const gaps: string[] = [];
  const parts = new Set<string>();
  const text = read(root, PARTS);
  if (text === null) return { gaps: [`${PARTS}: missing`], parts };

  // A part is a top-level item. An indented item is a note under its part.
  const lines = proseLines(text);
  const split = lines.findIndex((line) => NOT_PARTS.test(line));
  const listed = split === -1 ? lines : lines.slice(0, split);
  const items = listed.flatMap((line) => /^[-*]\s+(.+)$/.exec(line)?.[1] ?? []);
  if (items.length === 0) gaps.push(`${PARTS}: lists no part`);
  const notParts = (split === -1 ? [] : lines.slice(split + 1)).flatMap(
    (line) => /^[-*]\s+`([^`]+?)\/?`/.exec(line)?.[1] ?? [],
  );
  const covering = [...notParts];

  for (const item of items) {
    const name = (/^\[([^\]]+)\]/.exec(item)?.[1] ?? item).trim();
    const [doc] = linkedFiles(PARTS, item);
    if (!doc || path.posix.basename(doc) !== "AGENTS.md") {
      gaps.push(`${PARTS}: part "${name}" has no link to its AGENTS.md`);
      continue;
    }
    covering.push(path.posix.dirname(doc));
    const partText = read(root, doc);
    if (partText === null) {
      gaps.push(`${doc}: missing`);
      continue;
    }
    parts.add(doc);
    gaps.push(...missingFields(doc, partText, PART_FIELDS));
    const promises = fieldsOf(partText).get("Promises")?.trim();
    if (promises && !/^\s*1\.\s+\S/m.test(promises)) {
      gaps.push(`${doc}: "Promises" has no numbered promise`);
    }
  }
  for (const folder of codeFolders(root)) {
    const covered = covering.some((dir) => folder === dir || folder.startsWith(`${dir}/`));
    if (!covered) gaps.push(`${PARTS}: no part covers ${folder}`);
  }
  return { gaps, parts };
}

/** The folders that hold Rome's code: each folder directly under a code root, except one that holds another root. */
function codeFolders(root: string): string[] {
  return CODE_ROOTS.flatMap((codeRoot) => {
    const dir = path.join(root, codeRoot);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
      )
      .map((entry) => `${codeRoot}/${entry.name}`)
      .filter((folder) => !CODE_ROOTS.some((other) => other.startsWith(`${folder}/`)))
      .sort();
  });
}

function conceptGaps(root: string, parts: Set<string>): string[] {
  const dir = path.join(root, CONCEPTS);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".md"))
        .sort()
    : [];
  if (files.length === 0) return [`${CONCEPTS}: no concept`];

  return files.flatMap((name) => {
    const file = `${CONCEPTS}/${name}`;
    const text = readFileSync(path.join(dir, name), "utf8");
    const gaps = missingFields(file, text, CONCEPT_FIELDS);
    const carriedBy = fieldsOf(text).get("Carried by")?.trim();
    if (carriedBy && !linkedFiles(file, carriedBy).some((doc) => parts.has(doc))) {
      gaps.push(`${file}: "Carried by" links to no part of ${PARTS}`);
    }
    return gaps;
  });
}

/**
 * Every gap in the docs skeleton under `root`, known or not, each as one line
 * that opens with the file to change. The order is stable between runs.
 */
export function docsSkeletonGaps(root: string): string[] {
  const wholeProduct = WHOLE_PRODUCT.flatMap((file) => {
    const text = read(root, file);
    if (text === null) return [`${file}: missing`];
    const body = proseLines(text).filter((line) => line.trim() && !/^#{1,6}\s/.test(line));
    return body.length === 0 ? [`${file}: empty`] : [];
  });
  const { gaps, parts } = partGaps(root);
  return [...wholeProduct, ...gaps, ...conceptGaps(root, parts)];
}

/**
 * Splits the gaps found against the known list: `fresh` are found and not
 * listed, `closed` are listed and no longer found. Both must be empty to pass.
 */
export function judge(
  found: string[],
  known: readonly string[],
): { fresh: string[]; closed: string[] } {
  return {
    fresh: found.filter((gap) => !known.includes(gap)),
    closed: known.filter((gap) => !found.includes(gap)),
  };
}

/** Prints the verdict. 0 no gap beyond the known list, 1 the list is out of date, 2 the check could not run. */
export function runCli(root: string): number {
  let found: string[];
  try {
    found = docsSkeletonGaps(root);
  } catch (error) {
    console.error("docs-skeleton: unexpected failure");
    console.error(error);
    return 2;
  }
  const { fresh, closed } = judge(found, KNOWN_GAPS);

  for (const gap of found) console.log(`  - ${gap}${fresh.includes(gap) ? "  (new)" : ""}`);
  for (const gap of fresh) console.error(`docs-skeleton: new gap: ${gap}`);
  for (const gap of closed) {
    console.error(`docs-skeleton: closed, remove it from lint/docs-skeleton-gaps.ts: ${gap}`);
  }
  if (fresh.length > 0 || closed.length > 0) return 1;

  console.log(`docs-skeleton: ${found.length} known gap(s), none new`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")));
}
