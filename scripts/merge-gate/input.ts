// Validates the merge gate's input JSON. The shape is GateInput in gate.ts.

import type { ChangedFile, FileStatus, GateInput, MergePolicy, SelfMergeEntry } from "./gate.js";

const STATUSES: readonly FileStatus[] = ["added", "modified", "removed", "renamed"];

/** Thrown with a message naming the first malformed field. */
export class MalformedInput extends Error {}

/** Returns `raw` as a GateInput, or throws MalformedInput. Extra fields are ignored. */
export function parseInput(raw: unknown): GateInput {
  const root = object(raw, "input");
  const pr = object(root.pr, "pr");
  return {
    pr: { author: string(pr.author, "pr.author"), fromFork: boolean(pr.fromFork, "pr.fromFork") },
    policy: parsePolicy(root.policy),
    files: array(root.files, "files").map(parseFile),
  };
}

function parsePolicy(raw: unknown): MergePolicy {
  const p = object(raw, "policy");
  return {
    enabled: boolean(p.enabled, "policy.enabled"),
    author: string(p.author, "policy.author"),
    maxChangedLines: count(p.maxChangedLines, "policy.maxChangedLines"),
    selfMerge: array(p.selfMerge, "policy.selfMerge").map((e, i): SelfMergeEntry => {
      const at = `policy.selfMerge[${i}]`;
      const entry = object(e, at);
      return {
        paths: array(entry.paths, `${at}.paths`).map((g, j) => string(g, `${at}.paths[${j}]`)),
        ...(entry.reason === undefined ? {} : { reason: string(entry.reason, `${at}.reason`) }),
      };
    }),
  };
}

function parseFile(raw: unknown, i: number): ChangedFile {
  const at = `files[${i}]`;
  const f = object(raw, at);
  const status = string(f.status, `${at}.status`) as FileStatus;
  if (!STATUSES.includes(status)) {
    throw new MalformedInput(`${at}.status must be one of ${STATUSES.join(", ")}`);
  }
  const file: ChangedFile = {
    path: string(f.path, `${at}.path`),
    status,
    additions: count(f.additions, `${at}.additions`),
    deletions: count(f.deletions, `${at}.deletions`),
  };
  if (status === "renamed") file.previousPath = string(f.previousPath, `${at}.previousPath`);
  for (const key of ["patch", "baseContent", "headContent"] as const) {
    const v = f[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new MalformedInput(`${at}.${key} must be a string`);
    file[key] = v;
  }
  return file;
}

function object(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new MalformedInput(`${at} must be an object`);
  return v as Record<string, unknown>;
}

function array(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new MalformedInput(`${at} must be an array`);
  return v;
}

function string(v: unknown, at: string): string {
  if (typeof v !== "string" || v === "")
    throw new MalformedInput(`${at} must be a non-empty string`);
  return v;
}

function boolean(v: unknown, at: string): boolean {
  if (typeof v !== "boolean") throw new MalformedInput(`${at} must be a boolean`);
  return v;
}

function count(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new MalformedInput(`${at} must be a non-negative integer`);
  }
  return v;
}
