import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { renameSymbol } from "./rename-symbol.js";

let root: string;
const pkg = (p: string): string => join(root, p);
const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

function write(path: string, text: string): void {
  mkdirSync(dirname(pkg(path)), { recursive: true });
  writeFileSync(pkg(path), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rename-symbol-"));
  write("package.json", JSON.stringify({ type: "module" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true },
      include: ["src/**/*"],
    }),
  );
  write("src/a/source.ts", lines("export function oldName(): number {", "  return 1;", "}"));
  write("src/a/index.ts", 'export * from "./source.js";\n');
  write(
    "src/b/user.ts",
    lines(
      'import { oldName } from "../a/index.js";',
      'import * as ns from "../a/source.js";',
      "export const all = [oldName(), ns.oldName, { oldName }];",
    ),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("renameSymbol", () => {
  it("renames the declaration and every use, through a barrel, keeping object keys", () => {
    const service = renameSymbol(pkg("src/a/source.ts"), "oldName", "newName");

    expect(service.text(pkg("src/a/source.ts"))).toContain("export function newName()");
    expect(service.text(pkg("src/b/user.ts"))).toBe(
      lines(
        'import { newName } from "../a/index.js";',
        'import * as ns from "../a/source.js";',
        "export const all = [newName(), ns.newName, { oldName: newName }];",
      ),
    );
  });

  it("refuses a name the file does not declare at the top", () => {
    expect(() => renameSymbol(pkg("src/a/source.ts"), "x", "y")).toThrow(/x not declared/);
  });
});
