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
import { spawnSync } from "node:child_process";
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

/**
 * The lines of a doc that a reader sees as prose. A fenced code block is an
 * example that may hold a label or a link, and an HTML comment is a note to
 * the writer, so neither counts. The two are tracked together: a fence inside
 * a comment opens no block, and `<!--` inside a block or inline code opens no
 * comment. A block closes on a fence of the same character that is at least as
 * long as the one that opened it.
 */
function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  let inComment = false;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const opens = inComment ? undefined : /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (opens) {
      fence = opens;
      continue;
    }
    let shown = "";
    let at = 0;
    while (at < line.length) {
      if (inComment) {
        const close = line.indexOf("-->", at);
        if (close === -1) break;
        inComment = false;
        at = close + 3;
        continue;
      }
      const open = line.indexOf("<!--", at);
      if (open === -1) {
        shown += line.slice(at);
        break;
      }
      shown += line.slice(at, open);
      at = open + 4;
      if ((shown.split("`").length - 1) % 2 === 1) shown += "<!--";
      else inComment = true;
    }
    lines.push(shown);
  }
  return lines;
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
  // A link inside inline code is an example, not a link a reader can follow.
  const links = proseLines(text)
    .join("\n")
    .replace(/`[^`\n]*`/g, "")
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
  const covering: string[] = [];
  for (const line of split === -1 ? [] : lines.slice(split + 1)) {
    const named = /^[-*]\s+`([^`]+?)\/?`(.*)$/.exec(line);
    if (!named) continue;
    covering.push(named[1]);
    if (!/\w/.test(named[2])) gaps.push(`${PARTS}: "Not parts" names ${named[1]} with no reason`);
  }

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

/**
 * The folders that hold Rome's code: each folder directly under a code root
 * that holds a file git does not ignore, except a folder that holds another
 * root. A folder left behind with only ignored files, such as `node_modules`,
 * is not one, so a local run agrees with CI.
 */
function codeFolders(root: string): string[] {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...CODE_ROOTS],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.error || listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.error?.message ?? listed.stderr.toString()}`);
  }
  const files = listed.stdout.toString("utf8").split("\0");
  const folders = new Set<string>();
  for (const codeRoot of CODE_ROOTS) {
    for (const file of files) {
      const [name, ...rest] = file.startsWith(`${codeRoot}/`)
        ? file.slice(codeRoot.length + 1).split("/")
        : [];
      if (name && rest.length > 0) folders.add(`${codeRoot}/${name}`);
    }
  }
  // A set keeps the order of the roots, and git lists the files of a root by path.
  return [...folders].filter(
    (folder) => !CODE_ROOTS.some((other) => other.startsWith(`${folder}/`)),
  );
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
