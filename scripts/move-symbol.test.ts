import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { applySymbolPlan, planSymbolMove } from "./move-symbol.js";

let root: string;
const pkg = (p: string): string => join(root, "pkg", p);
const read = (p: string): string => readFileSync(pkg(p), "utf8");

function write(path: string, text: string): void {
  mkdirSync(dirname(pkg(path)), { recursive: true });
  writeFileSync(pkg(path), text);
}

function move(from: string, to: string, names: string[]): ReturnType<typeof planSymbolMove> {
  const m = { from: pkg(from), to: pkg(to), names };
  const plan = planSymbolMove(root, m);
  applySymbolPlan(root, m, plan);
  return plan;
}

const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "move-symbol-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src/**/*"],
    }),
  );
  write("src/b/dep.ts", "export const dep = 1;\n");
  write("src/b/types.ts", "export type Shape = { n: number };\n");
  write("src/b/other.ts", "export const unrelated = 2;\n");
  write(
    "src/a/source.ts",
    lines(
      'import { dep } from "../b/dep.js";',
      'import type { Shape } from "../b/types.js";',
      'import { unrelated } from "../b/other.js";',
      "",
      "export const keep = unrelated;",
      "",
      "/** Doubles a dep. */",
      "export function moved(x: Shape): number {",
      "  return dep + helper(x);",
      "}",
      "",
      "export function helper(_x: Shape): number {",
      "  return 1;",
      "}",
      "",
      "export interface Opts {",
      "  a: number;",
      "}",
      "",
      "function useMoved() {",
      "  return moved;",
      "}",
      "export { useMoved };",
    ),
  );
  write("src/a/index.ts", 'export * from "./source.js";\n');
  write(
    "src/b/user.ts",
    lines(
      'import { keep, moved, type Opts } from "../a/source.js";',
      'import { moved as m } from "@/a/source.js";',
      'export { moved as again } from "../a/source.js";',
      'export type Later = import("../a/source.js").Opts;',
      'export type Kept = import("../a/source.js").Keep;',
      'rs.mock("../a/source.js", () => ({}));',
      'import * as ns from "../a/source.js";',
      "export const all = [keep, moved, m, ns] as Opts[];",
    ),
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("planSymbolMove and applySymbolPlan", () => {
  it("moves declarations into a new file with their comments and the imports they use", () => {
    const plan = move("src/a/source.ts", "src/c/target.ts", ["moved", "Opts"]);

    expect(plan.created).toBe(true);
    expect(read("src/c/target.ts")).toBe(
      lines(
        'import { dep } from "../b/dep.js";',
        'import type { Shape } from "../b/types.js";',
        'import { helper } from "../a/source.js";',
        "",
        "/** Doubles a dep. */",
        "export function moved(x: Shape): number {",
        "  return dep + helper(x);",
        "}",
        "",
        "export interface Opts {",
        "  a: number;",
        "}",
      ),
    );
  });

  it("leaves the source importing what it still uses, and nothing only the moved code used", () => {
    move("src/a/source.ts", "src/c/target.ts", ["moved", "Opts"]);

    expect(read("src/a/source.ts")).toBe(
      lines(
        'import { moved } from "../c/target.js";',
        'import type { Shape } from "../b/types.js";',
        'import { unrelated } from "../b/other.js";',
        "",
        "export const keep = unrelated;",
        "",
        "export function helper(_x: Shape): number {",
        "  return 1;",
        "}",
        "",
        "function useMoved() {",
        "  return moved;",
        "}",
        "export { useMoved };",
      ),
    );
  });

  it("splits each importer so the moved names come from the new file, and lists what it cannot follow", () => {
    const plan = move("src/a/source.ts", "src/c/target.ts", ["moved", "Opts"]);

    expect(read("src/b/user.ts")).toBe(
      lines(
        'import { keep } from "../a/source.js";',
        'import { moved, type Opts } from "../c/target.js";',
        'import { moved as m } from "@/c/target.js";',
        'export { moved as again } from "../c/target.js";',
        'export type Later = import("../c/target.js").Opts;',
        'export type Kept = import("../a/source.js").Keep;',
        'rs.mock("../a/source.js", () => ({}));',
        'import * as ns from "../a/source.js";',
        "export const all = [keep, moved, m, ns] as Opts[];",
      ),
    );
    expect(plan.review).toEqual([
      expect.stringMatching(/^pkg\/src\/b\/user\.ts:6: rs\.mock/),
      expect.stringMatching(/^pkg\/src\/b\/user\.ts:7: .*\(namespace import\)$/),
    ]);
  });

  it("adds the moved names to a barrel that re-exports the source", () => {
    move("src/a/source.ts", "src/c/target.ts", ["moved", "Opts"]);

    expect(read("src/a/index.ts")).toBe(
      lines('export * from "./source.js";', 'export { moved, type Opts } from "../c/target.js";'),
    );
  });

  it("appends to an existing file and drops its own import of the moved name", () => {
    write(
      "src/c/target.ts",
      lines(
        'import { keep, moved } from "../a/source.js";',
        "",
        "export const both = [keep, moved];",
      ),
    );
    execFileSync("git", ["add", "-A"], { cwd: root });
    const plan = move("src/a/source.ts", "src/c/target.ts", ["moved"]);

    expect(plan.created).toBe(false);
    expect(read("src/c/target.ts")).toBe(
      lines(
        'import { keep } from "../a/source.js";',
        'import { dep } from "../b/dep.js";',
        'import type { Shape } from "../b/types.js";',
        'import { helper } from "../a/source.js";',
        "",
        "export const both = [keep, moved];",
        "",
        "/** Doubles a dep. */",
        "export function moved(x: Shape): number {",
        "  return dep + helper(x);",
        "}",
      ),
    );
  });

  it("exports a moved declaration that was private", () => {
    write("src/a/private.ts", lines("const secret = 1;", "export const shown = secret;"));
    execFileSync("git", ["add", "-A"], { cwd: root });
    move("src/a/private.ts", "src/a/secret.ts", ["secret"]);

    expect(read("src/a/secret.ts")).toBe("export const secret = 1;\n");
    expect(read("src/a/private.ts")).toBe(
      lines('import { secret } from "./secret.js";', "export const shown = secret;"),
    );
  });

  it("refuses a move that leaves an unexported neighbour behind", () => {
    write("src/a/private.ts", lines("const secret = 1;", "export const shown = secret;"));
    execFileSync("git", ["add", "-A"], { cwd: root });

    expect(() =>
      planSymbolMove(root, {
        from: pkg("src/a/private.ts"),
        to: pkg("src/c/t.ts"),
        names: ["shown"],
      }),
    ).toThrow(/uses secret, which stays .* unexported/);
  });

  it("refuses half of a variable statement and a name it cannot find", () => {
    write("src/a/pair.ts", "export const a = 1, b = 2;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    const m = (names: string[]) => ({ from: pkg("src/a/pair.ts"), to: pkg("src/c/t.ts"), names });

    expect(() => planSymbolMove(root, m(["a"]))).toThrow(/declared together; name b too/);
    expect(() => planSymbolMove(root, m(["nope"]))).toThrow(/nope not declared/);
  });
});
