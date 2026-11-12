import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { moveSymbol, tidyNewFile } from "./move-symbol.js";

let root: string;
const pkg = (p: string): string => join(root, p);
const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

function write(path: string, text: string): void {
  mkdirSync(dirname(pkg(path)), { recursive: true });
  writeFileSync(pkg(path), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "move-symbol-"));
  write("package.json", JSON.stringify({ type: "module" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src/**/*"],
    }),
  );
  write("src/b/dep.ts", "export const dep = 1;\n");
  write(
    "src/a/source.ts",
    lines(
      'import { dep } from "../b/dep.js";',
      "",
      "/** Doubles a dep. */",
      "export function moved(): number {",
      "  return dep + helper();",
      "}",
      "",
      "function helper(): number {",
      "  return 1;",
      "}",
      "",
      "export const kept = helper();",
      "",
      "export interface Opts {",
      "  a: number;",
      "}",
    ),
  );
  write(
    "src/b/user.ts",
    lines(
      'import { kept, moved, type Opts } from "../a/source.js";',
      "export const all: [number, number, Opts?] = [kept, moved()];",
    ),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("moveSymbol", () => {
  it("moves the named declarations together, with their comments and imports", () => {
    const text = moveSymbol(pkg("src/a/source.ts"), pkg("src/c/target.ts"), ["moved", "Opts"]).text(
      pkg("src/c/target.ts"),
    );

    expect(text).toContain('import { dep } from "../b/dep.js";');
    expect(text).toContain('import { helper } from "../a/source.js";');
    expect(text).toMatch(/\/\*\* Doubles a dep. \*\/\nexport function moved\(\)/);
    expect(text).toMatch(/}\n\nexport interface Opts/);
    expect(text).toContain("export interface Opts");
  });

  it("exports what the moved code still needs from the source", () => {
    const text = moveSymbol(pkg("src/a/source.ts"), pkg("src/c/target.ts"), ["moved", "Opts"]).text(
      pkg("src/a/source.ts"),
    );

    expect(text).toContain("export function helper()");
    expect(text).not.toContain("function moved");
    expect(text).not.toContain('from "../b/dep.js"');
  });

  it("rewrites importers with relative specifiers, never the `@/` alias", () => {
    const text = moveSymbol(pkg("src/a/source.ts"), pkg("src/c/target.ts"), ["moved", "Opts"]).text(
      pkg("src/b/user.ts"),
    ) as string;

    expect(text).toContain('from "../a/source.js"');
    expect(text).toContain('from "../c/target.js"');
    expect(text).not.toContain("@/");
  });

  it("re-exports the moved names from an `export *` barrel of the source", () => {
    write("src/a/index.ts", 'export * from "./source.js";\n');
    write(
      "src/b/barrel-user.ts",
      'import { moved } from "../a/index.js";\nexport const m = moved();\n',
    );

    const service = moveSymbol(pkg("src/a/source.ts"), pkg("src/c/target.ts"), ["moved", "Opts"]);

    expect(service.text(pkg("src/a/index.ts"))).toBe(
      lines(
        'export * from "./source.js";',
        'export { moved } from "../c/target.js";',
        'export type { Opts } from "../c/target.js";',
      ),
    );
  });

  it("lists mocks of the source and an import cycle between source and target", () => {
    write("src/b/user.test.ts", lines('rs.mock("../a/source.js", () => ({}));'));
    write(
      "src/a/cycle.ts",
      lines(
        "export const BASE = 1;",
        "export const moved2 = BASE + 1;",
        "export const derived = moved2 * 2;",
      ),
    );

    const { review } = moveSymbol(pkg("src/a/cycle.ts"), pkg("src/c/target.ts"), ["moved2"]);
    const mocks = moveSymbol(pkg("src/a/source.ts"), pkg("src/c/t.ts"), ["moved"]).review;

    expect(review.join("\n")).toMatch(/cycle\.ts and .*target\.ts import each other/);
    expect(mocks.join("\n")).toMatch(/user\.test\.ts:1: mocks .*source\.ts/);
  });

  it("lets a target import types from the source without calling it a cycle", () => {
    write(
      "src/a/types.ts",
      lines(
        "export type Kind = 1 | 2;",
        "export function kind(): Kind {",
        "  return 1;",
        "}",
        "export const first = kind();",
      ),
    );

    const { review } = moveSymbol(pkg("src/a/types.ts"), pkg("src/c/kind.ts"), ["kind"]);

    expect(review).toEqual([]);
  });

  it("tidies only the whitespace between statements of a new file", () => {
    const literal = "`first;\nconst second = 2;\n*/\n\nlast`";
    const text = lines("/** Doc. */", "", `export const s = ${literal};`, "export const t = 1;");

    expect(tidyNewFile("t.ts", text)).toBe(
      lines("/** Doc. */", `export const s = ${literal};`, "", "export const t = 1;"),
    );
  });

  it("refuses a name the file does not declare at the top", () => {
    expect(() => moveSymbol(pkg("src/a/source.ts"), pkg("src/c/t.ts"), ["nope"])).toThrow(
      /nope not declared/,
    );
  });
});
