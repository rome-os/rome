import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { MalformedInput, parseInput } from "./input.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "merge-gate-"));

function run(content: string) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, content);
  return spawnSync(join(ROOT, "node_modules/.bin/tsx"), ["scripts/merge-gate/decide.ts", path], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

const valid = {
  pr: { author: "zhangfand", fromFork: false },
  policy: {
    enabled: false,
    author: "zhangfand",
    maxChangedLines: 400,
    selfMerge: [{ paths: ["docs/**"], reason: "r" }],
  },
  files: [{ path: "docs/a.md", status: "modified", additions: 1, deletions: 0, patch: "+x" }],
};

describe("decide.ts", () => {
  it("prints the decision and exits 0", () => {
    const r = run(JSON.stringify(valid));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ verdict: "qualifies", action: "report-only" });
  });

  it("exits non-zero with a message on stderr for malformed JSON", () => {
    const r = run("{");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("merge-gate");
  });

  it("exits non-zero for a file with a bad status", () => {
    const r = run(JSON.stringify({ ...valid, files: [{ ...valid.files[0], status: "copied" }] }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("files[0].status");
  });
});

describe("parseInput", () => {
  it.each([
    ["no pr", { ...valid, pr: undefined }],
    ["a string fromFork", { ...valid, pr: { author: "a", fromFork: "no" } }],
    ["no policy", { ...valid, policy: undefined }],
    ["a negative maxChangedLines", { ...valid, policy: { ...valid.policy, maxChangedLines: -1 } }],
    [
      "selfMerge paths not strings",
      { ...valid, policy: { ...valid.policy, selfMerge: [{ paths: [1] }] } },
    ],
    ["files not an array", { ...valid, files: {} }],
    [
      "a rename without previousPath",
      { ...valid, files: [{ ...valid.files[0], status: "renamed" }] },
    ],
    ["fractional additions", { ...valid, files: [{ ...valid.files[0], additions: 1.5 }] }],
  ])("rejects %s", (_, raw) => {
    expect(() => parseInput(raw)).toThrow(MalformedInput);
  });

  it("accepts an empty patch and keeps a null one out", () => {
    const files = [
      { ...valid.files[0], patch: "" },
      { ...valid.files[0], patch: null },
    ];
    expect(parseInput({ ...valid, files }).files.map((f) => f.patch)).toEqual(["", undefined]);
  });

  it("accepts the policy file in the repo", () => {
    const policy = JSON.parse(readFileSync(join(ROOT, ".github/merge-policy.json"), "utf8"));
    expect(parseInput({ ...valid, policy }).policy).toEqual({
      enabled: false,
      author: "zhangfand",
      maxChangedLines: 400,
      selfMerge: [],
    });
  });
});
