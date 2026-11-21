// The merge gate's decision: whether a PR could merge without its author, and
// why. A pure function of the input, so decide.ts and tests share it.

import { matchesGlob } from "./glob.js";

export type FileStatus = "added" | "modified" | "removed" | "renamed";

export interface ChangedFile {
  path: string;
  status: FileStatus;
  /** Present only when `status` is `renamed`. */
  previousPath?: string;
  additions: number;
  deletions: number;
  /** Unified diff hunks. Absent for binary files. */
  patch?: string;
  /** Content on main, only for `goals/<goal>/baseline.json`. */
  baseContent?: string;
  /** Content in the PR, only for `goals/<goal>/baseline.json`. */
  headContent?: string;
}

export interface SelfMergeEntry {
  paths: string[];
  reason?: string;
}

export interface MergePolicy {
  enabled: boolean;
  author: string;
  maxChangedLines: number;
  selfMerge: SelfMergeEntry[];
}

export interface GateInput {
  pr: { author: string; fromFork: boolean };
  policy: MergePolicy;
  files: ChangedFile[];
}

export type ReasonCode =
  | "listed"
  | "not-author"
  | "fork"
  | "too-large"
  | "no-files"
  | "unlisted-path"
  | "guard-test"
  | "guard-check"
  | "guard-goal"
  | "guard-policy"
  | "guard-workflow"
  | "baseline-raised"
  | "cast-or-ignore";

export interface Reason {
  code: ReasonCode;
  path?: string;
  /** The policy entry the reason rests on: a `selfMerge` glob or a policy key. */
  entry?: string;
  detail: string;
}

export interface Decision {
  verdict: "qualifies" | "needs-you";
  action: "merge" | "report-only" | "none";
  reasons: Reason[];
  summary: string;
}

const POLICY_PATH = ".github/merge-policy.json";
/** Matches a goal's `baseline.json`, the only files whose content the gate reads. */
export const BASELINE = /^goals\/[^/]+\/baseline\.json$/;
const CHECK_GLOBS = ["scripts/check-*", "scripts/*-baseline.mjs"];
const CHECK_FILE_NAMES = new Set([
  "biome.jsonc",
  "knip.jsonc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);
const TEST_SEGMENTS = new Set(["test", "tests", "e2e", "__tests__"]);
const CAST_OR_IGNORE: { token: string; pattern: RegExp }[] = [
  { token: "as any", pattern: /\bas any\b/ },
  { token: "as unknown as", pattern: /\bas unknown as\b/ },
  { token: "@ts-ignore", pattern: /@ts-ignore/ },
  { token: "@ts-expect-error", pattern: /@ts-expect-error/ },
  { token: "@ts-nocheck", pattern: /@ts-nocheck/ },
  { token: "biome-ignore", pattern: /biome-ignore/ },
  { token: "eslint-disable", pattern: /eslint-disable/ },
];

/** Decides one PR. Never throws on input that matches `GateInput`. */
export function decide(input: GateInput): Decision {
  const { pr, policy, files } = input;
  const blocking: Reason[] = [];
  const listed: Reason[] = [];

  if (pr.author !== policy.author) {
    blocking.push({
      code: "not-author",
      entry: "author",
      detail: `The PR author ${pr.author} is not the policy author ${policy.author}.`,
    });
  }
  if (pr.fromFork) {
    blocking.push({ code: "fork", detail: "The PR comes from a fork." });
  }
  if (files.length === 0) {
    blocking.push({ code: "no-files", detail: "The PR changes no files." });
  }
  const changedLines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (changedLines > policy.maxChangedLines) {
    blocking.push({
      code: "too-large",
      entry: "maxChangedLines",
      detail: `The PR changes ${changedLines} lines, over the limit of ${policy.maxChangedLines}.`,
    });
  }

  for (const file of files) {
    const fileReasons: Reason[] = [];
    const paths =
      file.status === "renamed" && file.previousPath ? [file.path, file.previousPath] : [file.path];
    const globs = paths.map((p) => listingGlob(policy, p));

    paths.forEach((p, i) => {
      const glob = globs[i];
      const role = p === file.path ? "" : ` (renamed to ${file.path})`;
      if (glob === undefined) {
        fileReasons.push({
          code: "unlisted-path",
          path: p,
          entry: "selfMerge",
          detail: `${p}${role} matches no selfMerge glob.`,
        });
      }
      for (const guard of guardsFor(p, file.status)) {
        fileReasons.push({
          code: guard.code,
          path: p,
          ...(glob ? { entry: glob } : {}),
          detail: `${p}${role} ${guard.is}.`,
        });
      }
    });

    if (BASELINE.test(file.path) && file.status === "modified") {
      const why = baselineNotLowered(file);
      if (why) {
        fileReasons.push({
          code: "baseline-raised",
          path: file.path,
          ...(globs[0] ? { entry: globs[0] } : {}),
          detail: `${file.path} is not a pure lowering: ${why}.`,
        });
      }
    }

    const guarded = fileReasons.some((r) => r.code.startsWith("guard-"));
    if (!guarded && file.patch !== undefined) {
      const found = castsOrIgnores(file.patch);
      if (found.length > 0) {
        fileReasons.push({
          code: "cast-or-ignore",
          path: file.path,
          ...(globs[0] ? { entry: globs[0] } : {}),
          detail: `${file.path} adds ${found.map((t) => `\`${t}\``).join(", ")}.`,
        });
      }
    }

    blocking.push(...fileReasons);
    const glob = globs[0];
    if (glob !== undefined) {
      const entry = policy.selfMerge.find((e) => e.paths.includes(glob));
      const why = entry?.reason ? ` ${entry.reason}` : "";
      listed.push({
        code: "listed",
        path: file.path,
        entry: glob,
        detail: `${file.path} is listed by ${glob}.${why}`,
      });
    }
  }

  if (blocking.length > 0) {
    return {
      verdict: "needs-you",
      action: "none",
      reasons: blocking,
      summary: summarize("needs-you", policy, blocking),
    };
  }
  const action = policy.enabled ? "merge" : "report-only";
  return {
    verdict: "qualifies",
    action,
    reasons: listed,
    summary: summarize("qualifies", policy, listed),
  };
}

/** The first `selfMerge` glob, in policy order, that matches `path`. */
export function listingGlob(policy: MergePolicy, path: string): string | undefined {
  for (const entry of policy.selfMerge) {
    for (const glob of entry.paths) {
      if (matchesGlob(glob, path)) return glob;
    }
  }
  return undefined;
}

/** The guard codes `path` hits, each with what the path is, such as "is a test". */
export function guardsFor(path: string, status: FileStatus): { code: ReasonCode; is: string }[] {
  const guards: { code: ReasonCode; is: string }[] = [];
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";

  if (/^.*\.(test|spec)\..*$/.test(name) || segments.some((s) => TEST_SEGMENTS.has(s))) {
    guards.push({ code: "guard-test", is: "is a test" });
  }
  if (
    path.startsWith("lint/") ||
    CHECK_GLOBS.some((g) => matchesGlob(g, path)) ||
    CHECK_FILE_NAMES.has(name) ||
    matchesGlob("tsconfig*.json", name)
  ) {
    guards.push({ code: "guard-check", is: "is a check or its configuration" });
  }
  if (path.startsWith("goals/") && !(BASELINE.test(path) && status === "modified")) {
    guards.push({ code: "guard-goal", is: "is in a goal folder" });
  }
  if (path === POLICY_PATH) {
    guards.push({ code: "guard-policy", is: "is the merge policy" });
  } else if (path.startsWith(".github/") || path.startsWith("scripts/merge-gate/")) {
    guards.push({ code: "guard-workflow", is: "is a workflow or the merge gate itself" });
  }
  return guards;
}

/**
 * Why a modified baseline is not a pure lowering, or null when it is one: the
 * same set of key paths, every leaf a non-negative integer no higher than on
 * main, and at least one leaf lower.
 */
export function baselineNotLowered(
  file: Pick<ChangedFile, "baseContent" | "headContent">,
): string | null {
  if (file.baseContent === undefined || file.headContent === undefined) {
    return "the base or head content is missing";
  }
  const base = flatten(file.baseContent);
  const head = flatten(file.headContent);
  if (!base || !head) return "a version does not parse as an object of non-negative integers";

  const baseKeys = [...base.keys()];
  if (baseKeys.length !== head.size || baseKeys.some((k) => !head.has(k))) {
    return "it adds or removes a key";
  }
  let lowered = false;
  for (const [key, before] of base) {
    const after = head.get(key);
    if (before === null || after === null || after === undefined) continue;
    if (after > before) return `${displayKey(key)} rises from ${before} to ${after}`;
    if (after < before) lowered = true;
  }
  return lowered ? null : "no number goes down";
}

// Maps every key path, inner objects included, to its leaf value or null for an
// object, so a key added or removed anywhere changes the key set.
function flatten(content: string): Map<string, number | null> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const out = new Map<string, number | null>();
  const walk = (value: Record<string, unknown>, prefix: string[]): boolean => {
    for (const [k, v] of Object.entries(value)) {
      const keyPath = JSON.stringify([...prefix, k]);
      if (isPlainObject(v)) {
        out.set(keyPath, null);
        if (!walk(v, [...prefix, k])) return false;
      } else if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
        out.set(keyPath, v);
      } else {
        return false;
      }
    }
    return true;
  };
  return walk(parsed, []) ? out : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function displayKey(key: string): string {
  return (JSON.parse(key) as string[]).join(".");
}

/** The cast and ignore tokens on added lines of a unified diff, in table order. */
export function castsOrIgnores(patch: string): string[] {
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  return CAST_OR_IGNORE.filter(({ pattern }) => added.some((l) => pattern.test(l))).map(
    (c) => c.token,
  );
}

function summarize(verdict: Decision["verdict"], policy: MergePolicy, reasons: Reason[]): string {
  let head: string;
  if (verdict === "needs-you") {
    head = "**Merge gate: needs-you.** This PR cannot merge itself; it waits for you.";
  } else if (policy.enabled) {
    head =
      "**Merge gate: qualifies.** Every changed path is listed in the merge policy, so this PR merges itself.";
  } else {
    head =
      "**Merge gate: qualifies.** This PR would merge itself, but the merge policy has `enabled` false, so it only reports.";
  }
  const lines = reasons.map((r) => {
    const where = r.path ? ` \`${r.path}\`` : "";
    const entry = r.entry ? ` (policy entry \`${r.entry}\`)` : "";
    return `- \`${r.code}\`${where}${entry}: ${r.detail}`;
  });
  return [head, "", ...lines].join("\n");
}
