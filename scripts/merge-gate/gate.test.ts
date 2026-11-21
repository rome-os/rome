import { describe, expect, it } from "@rstest/core";
import {
  baselineNotLowered,
  type ChangedFile,
  type Decision,
  decide,
  type GateInput,
  type MergePolicy,
  SUMMARY_HEAD,
} from "./gate.js";

const LISTED = "packages/core/src/participation/**";
const policy: MergePolicy = {
  enabled: false,
  author: "zhangfand",
  maxChangedLines: 400,
  selfMerge: [
    { paths: [LISTED], reason: "The gates are pinned by wake-gate and send-gate tests." },
    {
      paths: [
        "goals/**",
        "scripts/**",
        ".github/**",
        "lint/**",
        "packages/**",
        "*.jsonc",
        "pnpm-*.yaml",
      ],
      reason: "Wide, to test guards.",
    },
  ],
};

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: "@@ -1,2 +1,3 @@\n line\n+const a = 1;\n-const b = 2;",
  ...over,
});

const input = (files: ChangedFile[], over: Partial<GateInput> = {}): GateInput => ({
  pr: { author: "zhangfand", fromFork: false },
  policy,
  files,
  ...over,
});

const codes = (d: Decision) => d.reasons.map((r) => `${r.code} ${r.path ?? ""}`.trim()).sort();

function expectSummaryNamesReasons(d: Decision) {
  const head =
    d.verdict === "needs-you"
      ? SUMMARY_HEAD.needsYou
      : d.action === "merge"
        ? SUMMARY_HEAD.qualifies
        : SUMMARY_HEAD.wouldMerge;
  expect(d.summary.split("\n")[0]).toBe(head);
  for (const r of d.reasons) {
    if (r.path) expect(d.summary).toContain(r.path);
    if (r.entry) expect(d.summary).toContain(r.entry);
  }
}

describe("decide", () => {
  it("reports a listed PR as one that would merge while the policy is off", () => {
    const d = decide(input([file("packages/core/src/participation/addressing.ts")]));
    expect(d.verdict).toBe("qualifies");
    expect(d.action).toBe("report-only");
    expect(d.summary).toContain("would merge");
    expect(d.reasons).toEqual([
      expect.objectContaining({
        code: "listed",
        path: "packages/core/src/participation/addressing.ts",
        entry: LISTED,
      }),
    ]);
    expectSummaryNamesReasons(d);
  });

  it("merges a listed PR while the policy is on", () => {
    const d = decide(
      input([file("packages/core/src/participation/a.ts")], {
        policy: { ...policy, enabled: true },
      }),
    );
    expect(d.action).toBe("merge");
    expect(d.summary).not.toContain("would merge");
  });

  it("gives one listed reason per changed path", () => {
    const d = decide(
      input([
        file("packages/core/src/participation/a.ts"),
        file("packages/core/src/participation/b/c.ts"),
      ]),
    );
    expect(codes(d)).toEqual([
      "listed packages/core/src/participation/a.ts",
      "listed packages/core/src/participation/b/c.ts",
    ]);
  });

  it("collects every blocking reason, not only the first", () => {
    const d = decide(
      input(
        [file("docs/a.md", { additions: 500 }), file("packages/core/src/participation/a.test.ts")],
        {
          pr: { author: "someone", fromFork: true },
        },
      ),
    );
    expect(d.verdict).toBe("needs-you");
    expect(d.action).toBe("none");
    expect(codes(d)).toEqual([
      "fork",
      "guard-test packages/core/src/participation/a.test.ts",
      "not-author",
      "too-large",
      "unlisted-path docs/a.md",
    ]);
    expect(d.summary).not.toContain("would merge");
    expectSummaryNamesReasons(d);
  });

  it("blocks a PR with no files", () => {
    expect(codes(decide(input([])))).toEqual(["no-files"]);
  });

  it("allows exactly maxChangedLines and blocks one more", () => {
    const at = (n: number) =>
      decide(input([file("packages/core/src/participation/a.ts", { additions: n, deletions: 0 })]));
    expect(at(400).verdict).toBe("qualifies");
    expect(codes(at(401))).toEqual(["too-large"]);
  });

  it("blocks a rename whose source is unlisted", () => {
    const d = decide(
      input([
        file("packages/core/src/participation/a.ts", {
          status: "renamed",
          previousPath: "docs/a.ts",
        }),
      ]),
    );
    expect(codes(d)).toEqual(["unlisted-path docs/a.ts"]);
  });

  it("blocks a rename whose source is a guard path", () => {
    const d = decide(
      input([
        file("packages/core/src/participation/a.ts", {
          status: "renamed",
          previousPath: "packages/core/src/participation/a.test.ts",
        }),
      ]),
    );
    expect(codes(d)).toEqual(["guard-test packages/core/src/participation/a.test.ts"]);
  });

  describe("summary", () => {
    it.each([
      [false, SUMMARY_HEAD.wouldMerge],
      [true, SUMMARY_HEAD.qualifies],
    ])("starts a qualifying summary, enabled %s, with its verdict line", (enabled, head) => {
      const d = decide(
        input([file("packages/core/src/participation/a.ts")], {
          policy: { ...policy, enabled },
        }),
      );
      expect(d.summary.split("\n")[0]).toBe(head);
    });

    it("starts a blocked summary with the needs-you line", () => {
      expect(decide(input([file("docs/a.md")])).summary.split("\n")[0]).toBe(SUMMARY_HEAD.needsYou);
    });
  });

  describe("reasons", () => {
    it("holds no listed reasons when the PR needs you", () => {
      const d = decide(input([file("packages/core/src/participation/a.ts"), file("docs/a.md")]));
      expect(codes(d)).toEqual(["unlisted-path docs/a.md"]);
    });

    it("lists a qualifying rename under its path only", () => {
      const d = decide(
        input([
          file("packages/core/src/participation/b.ts", {
            status: "renamed",
            previousPath: "packages/core/src/participation/a.ts",
          }),
        ]),
      );
      expect(codes(d)).toEqual(["listed packages/core/src/participation/b.ts"]);
    });

    it("gives a reason per side when both sides of a rename trigger the same code", () => {
      const d = decide(
        input([file("docs/b.md", { status: "renamed", previousPath: "docs/a.md" })]),
      );
      expect(codes(d)).toEqual(["unlisted-path docs/a.md", "unlisted-path docs/b.md"]);
    });

    it("gives PR-wide reasons no path and the right entry", () => {
      const d = decide(
        input([file("docs/a.md", { additions: 500 })], {
          pr: { author: "someone", fromFork: true },
        }),
      );
      const byCode = Object.fromEntries(d.reasons.map((r) => [r.code, r]));
      for (const code of ["not-author", "fork", "too-large"]) {
        expect(byCode[code]).not.toHaveProperty("path");
      }
      expect(byCode["not-author"]?.entry).toBe("author");
      expect(byCode["too-large"]?.entry).toBe("maxChangedLines");
      expect(byCode.fork).not.toHaveProperty("entry");
      expect(byCode["unlisted-path"]?.entry).toBe("selfMerge");
      const none = decide(input([])).reasons[0];
      expect(none).not.toHaveProperty("path");
      expect(none).not.toHaveProperty("entry");
    });

    it("names the first matching glob in policy order", () => {
      const ordered: MergePolicy = {
        ...policy,
        selfMerge: [{ paths: ["docs/*.txt", "docs/**", "docs/a.md"] }, { paths: ["docs/a.md"] }],
      };
      const d = decide(input([file("docs/a.md")], { policy: ordered }));
      expect(d.reasons[0]).toMatchObject({ code: "listed", entry: "docs/**" });
    });
  });

  describe("guards", () => {
    it.each([
      ["packages/core/src/participation/a.test.ts", "guard-test"],
      ["packages/core/src/participation/a.spec.tsx", "guard-test"],
      ["packages/core/src/participation/__tests__/a.ts", "guard-test"],
      ["packages/core/src/participation/test/kit.ts", "guard-test"],
      ["packages/core/src/participation/tests/kit.ts", "guard-test"],
      ["packages/core/src/participation/e2e/flow.ts", "guard-test"],
      ["lint/import-rules.ts", "guard-check"],
      ["scripts/check-prose.mjs", "guard-check"],
      ["scripts/prose-baseline.mjs", "guard-check"],
      ["biome.jsonc", "guard-check"],
      ["knip.jsonc", "guard-check"],
      ["packages/core/package.json", "guard-check"],
      ["pnpm-lock.yaml", "guard-check"],
      ["pnpm-workspace.yaml", "guard-check"],
      ["packages/core/tsconfig.build.json", "guard-check"],
      ["goals/no-wakes/README.md", "guard-goal"],
      [".github/merge-policy.json", "guard-policy"],
      [".github/workflows/ci.yml", "guard-workflow"],
      ["scripts/merge-gate/gate.ts", "guard-workflow"],
    ])("%s is %s even when listed", (path, code) => {
      const d = decide(input([file(path)]));
      expect(d.verdict).toBe("needs-you");
      expect(d.reasons.map((r) => r.code)).toContain(code);
      expect(d.reasons.every((r) => r.code !== "unlisted-path")).toBe(true);
      expectSummaryNamesReasons(d);
    });

    it("reports only the guard, without entry, for an unlisted guard path", () => {
      const d = decide(input([file("tsconfig.json")]));
      expect(codes(d)).toEqual(["guard-check tsconfig.json"]);
      expect(d.reasons[0]).not.toHaveProperty("entry");
    });

    it("reports every guard a path hits", () => {
      expect(codes(decide(input([file("scripts/check-prose.test.mjs")])))).toEqual([
        "guard-check scripts/check-prose.test.mjs",
        "guard-test scripts/check-prose.test.mjs",
      ]);
    });

    it.each([
      "packages/x/lint/a.ts",
      "packages/x/goals/g/a.md",
      "packages/x/.github/a.yml",
      "packages/x/scripts/check-a.mjs",
      "packages/x/scripts/merge-gate/a.ts",
      "scripts/sub/check-a.mjs",
      "scripts/sub/a-baseline.mjs",
    ])("does not guard %s, which is not at the root rule's place", (path) => {
      expect(decide(input([file(path)])).verdict).toBe("qualifies");
    });

    it.each([
      "packages/x/biome.jsonc",
      "a/b/knip.jsonc",
      "a/pnpm-lock.yaml",
      "a/pnpm-workspace.yaml",
      "package.json",
      "a/tsconfig.json",
    ])("guards the check file %s at any depth", (path) => {
      expect(decide(input([file(path)])).reasons.map((r) => r.code)).toEqual(["guard-check"]);
    });

    it("names the listing glob as the entry of a guard on a listed path", () => {
      const d = decide(input([file("packages/core/src/participation/a.test.ts")]));
      expect(d.reasons[0]).toMatchObject({ code: "guard-test", entry: LISTED });
    });

    it.each(["added", "removed"] as const)("treats a %s baseline as a goal change", (status) => {
      const d = decide(input([file("goals/g/baseline.json", { status, headContent: '{"a":1}' })]));
      expect(codes(d)).toEqual(["guard-goal goals/g/baseline.json"]);
    });

    it("treats a renamed baseline as a goal change", () => {
      const d = decide(
        input([
          file("goals/h/baseline.json", {
            status: "renamed",
            previousPath: "goals/g/baseline.json",
          }),
        ]),
      );
      expect(codes(d)).toEqual([
        "guard-goal goals/g/baseline.json",
        "guard-goal goals/h/baseline.json",
      ]);
    });

    it("treats a nested baseline.json as a goal change", () => {
      expect(codes(decide(input([file("goals/g/sub/baseline.json")])))).toEqual([
        "guard-goal goals/g/sub/baseline.json",
      ]);
    });
  });

  describe("baselines", () => {
    const baseline = (baseContent?: string, headContent?: string) =>
      decide(input([file("goals/g/baseline.json", { baseContent, headContent })]));

    it("lets a listed pure lowering qualify", () => {
      const d = baseline('{"a":3,"n":{"b":2}}', '{"a":3,"n":{"b":1}}');
      expect(d.verdict).toBe("qualifies");
      expect(d.reasons[0]).toMatchObject({ code: "listed", entry: "goals/**" });
    });

    it("requires a pure lowering to be listed", () => {
      const d = decide(
        input([file("goals/g/baseline.json", { baseContent: '{"a":2}', headContent: '{"a":1}' })], {
          policy: { ...policy, selfMerge: [{ paths: [LISTED] }] },
        }),
      );
      expect(codes(d)).toEqual(["unlisted-path goals/g/baseline.json"]);
    });

    it.each([
      ["a raised number", '{"a":2,"b":5}', '{"a":1,"b":6}'],
      ["an unchanged file", '{"a":2}', '{"a":2}'],
      ["an added key", '{"a":2}', '{"a":1,"b":0}'],
      ["a removed key", '{"a":2,"b":1}', '{"a":1}'],
      ["a nested added key", '{"n":{"a":2}}', '{"n":{"a":1,"b":0}}'],
      ["an object replaced by a leaf", '{"n":{"a":2},"b":3}', '{"n":0,"b":3}'],
      ["a non-integer", '{"a":2}', '{"a":1.5}'],
      ["a negative number", '{"a":2}', '{"a":-1}'],
      ["a string leaf", '{"a":2}', '{"a":"1"}'],
      ["unparseable head", '{"a":2}', "{a:1"],
      ["an array root", "[2]", "[1]"],
      ["a number root", "2", "1"],
      ["a null leaf", '{"a":2,"b":1}', '{"a":1,"b":null}'],
      ["an array leaf", '{"a":2,"b":[1]}', '{"a":1,"b":[1]}'],
      ["a fraction on main", '{"a":2,"b":0.5}', '{"a":1,"b":0.5}'],
      ["an object turned leaf while another lowers", '{"a":2,"e":{}}', '{"a":1,"e":0}'],
      ["a dropped empty object", '{"a":2,"e":{}}', '{"a":1}'],
      ["missing base", undefined, '{"a":1}'],
      ["missing head", '{"a":2}', undefined],
    ])("blocks %s as baseline-raised", (_, base, head) => {
      const d = baseline(base, head);
      expect(codes(d)).toEqual(["baseline-raised goals/g/baseline.json"]);
      expect(d.reasons[0]?.entry).toBe("goals/**");
      expectSummaryNamesReasons(d);
    });

    it("keeps an empty object on both sides", () => {
      expect(baseline('{"a":2,"e":{}}', '{"a":1,"e":{}}').verdict).toBe("qualifies");
    });

    it("checks a baseline for casts and ignores", () => {
      const d = decide(
        input([
          file("goals/g/baseline.json", {
            baseContent: '{"a":2}',
            headContent: '{"a":1}',
            patch: '@@ -1 +1 @@\n-{"a":2}\n+{"a":1} // @ts-ignore',
          }),
        ]),
      );
      expect(codes(d)).toEqual(["cast-or-ignore goals/g/baseline.json"]);
    });

    it("explains which key rose", () => {
      expect(
        baselineNotLowered({ baseContent: '{"n":{"b":1}}', headContent: '{"n":{"b":2}}' }),
      ).toBe("n.b rises from 1 to 2");
    });
  });

  describe("casts and ignores", () => {
    const withLine = (line: string, path = "packages/core/src/participation/a.ts") =>
      decide(input([file(path, { patch: `@@ -1,1 +1,2 @@\n line\n${line}` })]));

    it.each([
      "+const x = y as any;",
      "+const x = y as unknown as Z;",
      "+// @ts-ignore",
      "+// @ts-expect-error broken upstream",
      "+// @ts-nocheck",
      "+// biome-ignore lint/style: reason",
      "+/* eslint-disable */",
      "+const x = y as any[];",
      "+f((z as unknown as T));",
      "+//eslint-disable-next-line",
    ])("blocks an added %s", (line) => {
      const d = withLine(line);
      expect(codes(d)).toEqual(["cast-or-ignore packages/core/src/participation/a.ts"]);
      expect(d.reasons[0]?.entry).toBe(LISTED);
      expectSummaryNamesReasons(d);
    });

    it.each([
      ["a removed line", "-const x = y as any;"],
      ["a context line", " const x = y as any;"],
      ["a file header", "+++ b/as any.ts"],
      ["a word that only contains the letters", "+const alias anything = 1;"],
      ["words that run into the tokens", "+// has anyone seen it"],
    ])("ignores %s", (_, line) => {
      expect(withLine(line).verdict).toBe("qualifies");
    });

    it("does not add cast-or-ignore to a guard path", () => {
      expect(codes(withLine("+x as any", "packages/core/src/participation/a.test.ts"))).toEqual([
        "guard-test packages/core/src/participation/a.test.ts",
      ]);
    });

    it("still checks an unlisted path", () => {
      expect(codes(withLine("+x as any", "docs/a.ts"))).toEqual([
        "cast-or-ignore docs/a.ts",
        "unlisted-path docs/a.ts",
      ]);
    });

    it("skips a file without a patch", () => {
      expect(
        decide(input([file("packages/core/src/participation/logo.png", { patch: undefined })]))
          .verdict,
      ).toBe("qualifies");
    });
  });
});
