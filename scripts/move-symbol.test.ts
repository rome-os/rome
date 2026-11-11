import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { moveSymbol } from "./move-symbol.js";

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

  it("refuses a name the file does not declare at the top", () => {
    expect(() => moveSymbol(pkg("src/a/source.ts"), pkg("src/c/t.ts"), ["nope"])).toThrow(
      /nope not declared/,
    );
  });
});
