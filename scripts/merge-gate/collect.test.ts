import { describe, expect, it } from "@rstest/core";
import {
  type ApiFile,
  type CheckReport,
  changedFile,
  errorReport,
  type GitHub,
  gatherFiles,
  type PullRequest,
  pullRequestFrom,
  reportFor,
  runGate,
  wholeFileAdded,
} from "./collect.js";
import type { Decision } from "./gate.js";

const event = (over: { headRepo?: string | null } = {}) => ({
  action: "synchronize",
  pull_request: {
    number: 7,
    user: { login: "zhangfand" },
    base: { sha: "base1", repo: { full_name: "o/rome" } },
    head: {
      sha: "head1",
      repo: over.headRepo === null ? null : { full_name: over.headRepo ?? "o/rome" },
    },
  },
});

const pr: PullRequest = {
  repo: "o/rome",
  number: 7,
  author: "zhangfand",
  fromFork: false,
  baseSha: "base1",
  headSha: "head1",
};

const policy = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    enabled: false,
    author: "zhangfand",
    maxChangedLines: 400,
    selfMerge: [{ paths: ["docs/**", "goals/*/baseline.json"], reason: "Prose." }],
    ...over,
  });

const api = (filename: string, over: Partial<ApiFile> = {}): ApiFile => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "@@ -1 +1,2 @@\n line\n+more",
  ...over,
});

/** A fake GitHub. `contents` maps `ref:path` to file text; `fail` makes listFiles throw. */
function fakeGitHub(files: ApiFile[], contents: Record<string, string> = {}, fail?: Error) {
  const reads: string[] = [];
  const posted: CheckReport[] = [];
  const gh: GitHub = {
    async listFiles() {
      if (fail) throw fail;
      return files;
    },
    async readFile(_repo, path, ref) {
      reads.push(`${ref}:${path}`);
      return contents[`${ref}:${path}`];
    },
    async putCheckRun(_repo, _sha, report) {
      posted.push(report);
    },
    async autoMerge() {
      return { pullRequestId: "PR_1", enabled: false };
    },
    async enableAutoMerge() {},
    async disableAutoMerge() {},
  };
  return { gh, reads, posted };
}

describe("pullRequestFrom", () => {
  it("reads the PR facts from the event", () => {
    expect(pullRequestFrom(event())).toEqual(pr);
  });

  it("marks a PR from another repository as a fork", () => {
    expect(pullRequestFrom(event({ headRepo: "someone/rome" })).fromFork).toBe(true);
  });

  it("marks a PR whose fork was deleted as a fork", () => {
    expect(pullRequestFrom(event({ headRepo: null })).fromFork).toBe(true);
  });

  it("throws on an event with no pull request", () => {
    expect(() => pullRequestFrom({ action: "opened" })).toThrow("pull_request");
  });
});

describe("changedFile", () => {
  it("keeps a rename's previous path", () => {
    expect(
      changedFile(api("docs/b.md", { status: "renamed", previous_filename: "docs/a.md" })),
    ).toMatchObject({ path: "docs/b.md", status: "renamed", previousPath: "docs/a.md" });
  });

  it.each([
    ["copied", "added"],
    ["changed", "modified"],
    ["unchanged", "modified"],
    ["removed", "removed"],
  ])("maps GitHub's %s to %s", (from, to) => {
    expect(changedFile(api("docs/a.md", { status: from })).status).toBe(to);
  });

  it("leaves the patch out for a binary file", () => {
    const { patch: _, ...binary } = api("docs/a.png", { additions: 0 });
    expect(changedFile(binary)).not.toHaveProperty("patch");
  });
});

describe("gatherFiles", () => {
  it("adds the base and head text of a modified baseline, and reads nothing else", async () => {
    const { gh, reads } = fakeGitHub([api("goals/g/baseline.json"), api("docs/a.md")], {
      "base1:goals/g/baseline.json": '{"x": 3}',
      "head1:goals/g/baseline.json": '{"x": 2}',
    });
    const files = await gatherFiles(gh, pr);
    expect(files[0]).toMatchObject({ baseContent: '{"x": 3}', headContent: '{"x": 2}' });
    expect(files[1]).not.toHaveProperty("baseContent");
    expect(reads).toEqual(["base1:goals/g/baseline.json", "head1:goals/g/baseline.json"]);
  });

  it("reads no base text for an added baseline and no head text for a removed one", async () => {
    const { gh, reads } = fakeGitHub([
      api("goals/a/baseline.json", { status: "added" }),
      api("goals/r/baseline.json", { status: "removed" }),
    ]);
    await gatherFiles(gh, pr);
    expect(reads).toEqual(["head1:goals/a/baseline.json", "base1:goals/r/baseline.json"]);
  });

  it("reads a renamed baseline's base text at its previous path", async () => {
    const { gh, reads } = fakeGitHub([
      api("goals/new/baseline.json", {
        status: "renamed",
        previous_filename: "goals/old/baseline.json",
      }),
    ]);
    await gatherFiles(gh, pr);
    expect(reads).toEqual(["base1:goals/old/baseline.json", "head1:goals/new/baseline.json"]);
  });

  it("stands in the whole head text for a patch GitHub left out of a text file", async () => {
    const { patch: _, ...big } = api("docs/big.ts", { additions: 5000 });
    const { gh } = fakeGitHub([big], { "head1:docs/big.ts": "const a = b as any;\n" });
    const [file] = await gatherFiles(gh, pr);
    expect(file?.patch).toBe("@@ -0,0 +1,1 @@\n+const a = b as any;");
  });
});

describe("wholeFileAdded", () => {
  it("adds every line, without one for the final newline", () => {
    expect(wholeFileAdded("a\nb\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
  });
});

describe("runGate", () => {
  it("decides a listed PR from the API data and the policy text", async () => {
    const { gh } = fakeGitHub([api("docs/a.md")]);
    const out = await runGate(gh, pr, () => policy());
    expect(out).toMatchObject({ decision: { verdict: "qualifies", action: "report-only" } });
  });

  it("returns the error when the policy on main is malformed", async () => {
    const { gh } = fakeGitHub([api("docs/a.md")]);
    const out = await runGate(gh, pr, () => policy({ maxChangedLines: "many" }));
    expect(out).toHaveProperty("error");
    expect(String((out as { error: Error }).error.message)).toContain("maxChangedLines");
  });

  it("returns the error when the policy file does not parse, with enabled unknown and so true", async () => {
    const { gh } = fakeGitHub([api("docs/a.md")]);
    expect(await runGate(gh, pr, () => "{")).toMatchObject({ enabled: true });
    expect(await runGate(gh, pr, () => "{")).toHaveProperty("error");
  });

  it("treats a policy file that cannot be read as enabled", async () => {
    const { gh } = fakeGitHub([api("docs/a.md")]);
    const out = await runGate(gh, pr, () => {
      throw new Error("ENOENT");
    });
    expect(out).toMatchObject({ enabled: true });
  });

  it("carries the policy's enabled through an error once the policy parses", async () => {
    const { gh } = fakeGitHub([], {}, new Error("GitHub GET /files returned 502"));
    expect(await runGate(gh, pr, () => policy())).toMatchObject({ enabled: false });
    expect(await runGate(gh, pr, () => policy({ enabled: true }))).toMatchObject({
      enabled: true,
    });
  });

  it("returns the error when the API fails", async () => {
    const { gh } = fakeGitHub([], {}, new Error("GitHub GET /files returned 502"));
    const out = await runGate(gh, pr, () => policy());
    expect(reportOf(out).title).toBe("needs you: the gate could not decide");
  });

  it("blocks a PR that lists its own paths in the policy, judged by main's policy", async () => {
    const { gh } = fakeGitHub([api(".github/merge-policy.json"), api("packages/core/src/x.ts")]);
    const out = await runGate(gh, pr, () => policy());
    const codes = "decision" in out ? out.decision.reasons.map((r) => r.code) : [];
    expect(codes).toContain("guard-policy");
    expect(codes).toContain("unlisted-path");
  });

  it("blocks a PR that edits the gate or the workflow", async () => {
    const { gh } = fakeGitHub([
      api("scripts/merge-gate/gate.ts"),
      api(".github/workflows/merge-gate.yml"),
    ]);
    const out = await runGate(gh, pr, () =>
      policy({ selfMerge: [{ paths: ["**"], reason: "Everything." }] }),
    );
    expect(reportOf(out).conclusion).toBe("neutral");
    const codes = "decision" in out ? out.decision.reasons.map((r) => r.code) : [];
    expect(codes.filter((c) => c === "guard-workflow")).toHaveLength(2);
  });
});

function reportOf(out: Awaited<ReturnType<typeof runGate>>): CheckReport {
  return "decision" in out ? reportFor(out.decision) : errorReport(out.error);
}

const decision = (over: Partial<Decision>): Decision => ({
  verdict: "qualifies",
  action: "report-only",
  reasons: [],
  summary: "**Merge gate: qualifies.** This PR would merge itself.",
  ...over,
});

describe("reportFor", () => {
  it("says the PR would merge itself while the policy is off", () => {
    expect(reportFor(decision({}))).toEqual({
      title: "would merge itself",
      summary: "**Merge gate: qualifies.** This PR would merge itself.",
      conclusion: "success",
    });
  });

  it("says qualifies when the policy is on", () => {
    expect(reportFor(decision({ action: "merge" }))).toMatchObject({
      title: "qualifies",
      conclusion: "success",
    });
  });

  it("counts the reasons when the PR needs you", () => {
    const reasons = [
      { code: "fork" as const, detail: "x" },
      { code: "no-files" as const, detail: "y" },
    ];
    expect(reportFor(decision({ verdict: "needs-you", action: "none", reasons }))).toMatchObject({
      title: "needs you: 2 reasons",
      conclusion: "neutral",
    });
  });

  it("uses the singular for one reason", () => {
    const reasons = [{ code: "fork" as const, detail: "x" }];
    expect(reportFor(decision({ verdict: "needs-you", action: "none", reasons })).title).toBe(
      "needs you: 1 reason",
    );
  });

  it("cuts a summary over GitHub's limit", () => {
    const summary = "x".repeat(70_000);
    expect(reportFor(decision({ summary })).summary.length).toBeLessThanOrEqual(65_535);
  });
});

describe("errorReport", () => {
  it("names the error and needs you", () => {
    const r = errorReport(new Error("policy.author must be a non-empty string"));
    expect(r.title).toBe("needs you: the gate could not decide");
    expect(r.conclusion).toBe("neutral");
    expect(r.summary).toContain("policy.author must be a non-empty string");
  });
});
