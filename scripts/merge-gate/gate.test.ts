import { describe, expect, it } from "@rstest/core";
import {
  baselineNotLowered,
  type ChangedFile,
  type Decision,
  decide,
  type GateInput,
  type MergePolicy,
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
  expect(d.summary.split("\n")[0]).toContain(d.verdict);
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

    it("reports both the guard and unlisted-path for an unlisted guard path", () => {
      const d = decide(input([file("tsconfig.json")]));
      expect(codes(d)).toEqual(["guard-check tsconfig.json", "unlisted-path tsconfig.json"]);
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
      ["missing base", undefined, '{"a":1}'],
      ["missing head", '{"a":2}', undefined],
    ])("blocks %s as baseline-raised", (_, base, head) => {
      const d = baseline(base, head);
      expect(codes(d)).toEqual(["baseline-raised goals/g/baseline.json"]);
      expect(d.reasons[0]?.entry).toBe("goals/**");
      expectSummaryNamesReasons(d);
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
