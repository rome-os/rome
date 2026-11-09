import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { applyPlan, findMentions, type Move, planMoves } from "./move-files.js";

let root: string;
const pkg = (p: string): string => join(root, "pkg", p);
const read = (p: string): string => readFileSync(join(root, p), "utf8");

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function move(...pairs: Array<[string, string]>): {
  plan: ReturnType<typeof planMoves>;
  mentions: string[];
} {
  const moves: Move[] = pairs.map(([from, to]) => ({ from: pkg(from), to: pkg(to) }));
  const plan = planMoves(root, moves);
  applyPlan(root, plan);
  return { plan, mentions: findMentions(root, moves, plan) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "move-files-"));
  write("package.json", JSON.stringify({ type: "module" }));
  write(
    "pkg/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        resolveJsonModule: true,
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src/**/*"],
    }),
  );
  write(
    "pkg/src/a/thing.ts",
    'import { dep } from "../b/dep.js";\nexport const thing = dep;\nexport type T = 1;\n',
  );
  write("pkg/src/a/index.ts", 'export * from "./thing.js";\n');
  write("pkg/src/a/data.json", "{}\n");
  write(
    "pkg/src/a/reads-data.ts",
    'import data from "./data.json" with { type: "json" };\nexport { data };\n',
  );
  write("pkg/src/b/dep.ts", "export const dep = 1;\n");
  write(
    "pkg/src/b/user.ts",
    [
      'import { thing } from "../a/thing.js";',
      'export * from "../a/index.js";',
      'import { dep } from "./dep.js";',
      'import { thing as aliased } from "@/a/thing.js";',
      'rs.mock("../a/thing.js", () => ({}));',
      'export const later = () => import("../a/thing.js");',
      'export type Later = import("../a/thing.js").T;',
      "export { thing, dep, aliased };",
      "",
    ].join("\n"),
  );
  write(
    "other/src/test.ts",
    'import { thing } from "../../pkg/src/a/thing.js";\nexport { thing };\n',
  );
  write("knip.json", JSON.stringify({ entry: ["src/a/thing.ts"] }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("planMoves and applyPlan", () => {
  it("moves a folder and respells imports into it, keeping each specifier's ending", () => {
    const { plan } = move(["src/a", "src/ctx/a"]);

    expect(existsSync(pkg("src/a/thing.ts"))).toBe(false);
    expect(existsSync(pkg("src/ctx/a/thing.ts"))).toBe(true);
    // Non-TS files in the folder travel with it.
    expect(existsSync(pkg("src/ctx/a/data.json"))).toBe(true);
    expect(read("pkg/src/b/user.ts")).toBe(
      [
        'import { thing } from "../ctx/a/thing.js";',
        'export * from "../ctx/a/index.js";',
        'import { dep } from "./dep.js";',
        'import { thing as aliased } from "@/ctx/a/thing.js";',
        'rs.mock("../ctx/a/thing.js", () => ({}));',
        'export const later = () => import("../ctx/a/thing.js");',
        'export type Later = import("../ctx/a/thing.js").T;',
        "export { thing, dep, aliased };",
        "",
      ].join("\n"),
    );
    expect(plan.rewritten).toBe(8);
  });

  it("respells a moved file's own imports and leaves its sibling imports alone", () => {
    move(["src/a", "src/ctx/a"]);

    expect(read("pkg/src/ctx/a/thing.ts")).toContain('from "../../b/dep.js"');
    expect(read("pkg/src/ctx/a/index.ts")).toBe('export * from "./thing.js";\n');
    expect(read("pkg/src/ctx/a/reads-data.ts")).toContain('from "./data.json"');
  });

  it("respells imports from other packages that reach in by relative path", () => {
    move(["src/a", "src/ctx/a"]);

    expect(read("other/src/test.ts")).toContain('from "../../pkg/src/ctx/a/thing.js"');
  });

  it("moves a single file and the imports of the file it leaves behind", () => {
    move(["src/b/dep.ts", "src/ctx/dep.ts"]);

    expect(read("pkg/src/a/thing.ts")).toContain('from "../ctx/dep.js"');
    expect(read("pkg/src/b/user.ts")).toContain('import { dep } from "../ctx/dep.js";');
  });

  it("lists the hand-built paths it cannot rewrite", () => {
    const { mentions } = move(["src/a", "src/ctx/a"]);

    expect(mentions).toEqual([expect.stringMatching(/^knip\.json:1:/)]);
  });

  it("refuses a destination that already exists", () => {
    expect(() =>
      planMoves(root, [{ from: pkg("src/b/dep.ts"), to: pkg("src/a/thing.ts") }]),
    ).toThrow(/already exists/);
  });

  it("refuses a move that leaves the package", () => {
    expect(() =>
      planMoves(root, [{ from: pkg("src/b/dep.ts"), to: join(root, "other/src/dep.ts") }]),
    ).toThrow(/leaves/);
  });
});
