import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { planRename } from "./rename-symbol.js";

let root: string;
const pkg = (p: string): string => join(root, "pkg", p);
const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

function write(path: string, text: string): void {
  mkdirSync(dirname(pkg(path)), { recursive: true });
  writeFileSync(pkg(path), text);
}

function rename(file: string, from: string, to: string): ReturnType<typeof planRename> {
  const plan = planRename(root, { file: pkg(file), from, to });
  for (const [path, text] of plan.edits) writeFileSync(path, text);
  return plan;
}

const read = (p: string): string => readFileSync(pkg(p), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rename-symbol-"));
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
  write(
    "src/a/source.ts",
    lines(
      "/** Reads it. See {@link oldName}. */",
      "export function oldName(x: number): number {",
      "  const oldNameLocal = { oldName };",
      "  return x + Object.keys(oldNameLocal).length;",
      "}",
      "export const other = oldName(1);",
    ),
  );
  write("src/a/index.ts", 'export * from "./source.js";\n');
  write("src/a/named.ts", 'export { oldName } from "./source.js";\n');
  write(
    "src/b/user.ts",
    lines(
      'import { oldName, other } from "../a/source.js";',
      'import { oldName as aliased } from "@/a/source.js";',
      'import * as ns from "../a/source.js";',
      'export type T = ReturnType<typeof import("../a/source.js").oldName>;',
      'rs.mock("../a/source.js", () => ({}));',
      "export const all = [oldName(2), aliased, ns.oldName, other, { oldName }];",
      "export { oldName };",
    ),
  );
  write(
    "src/b/via-barrel.ts",
    'import { oldName } from "../a/index.js";\nexport const v = oldName;\n',
  );
  write(
    "src/b/via-named.ts",
    'import { oldName } from "../a/named.js";\nexport const v = oldName;\n',
  );
  write("src/b/via-user.ts", 'import { oldName } from "./user.js";\nexport const v = oldName;\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("planRename", () => {
  it("renames the declaration and every use in its file, keeping object keys", () => {
    rename("src/a/source.ts", "oldName", "newName");

    expect(read("src/a/source.ts")).toBe(
      lines(
        "/** Reads it. See {@link newName}. */",
        "export function newName(x: number): number {",
        "  const oldNameLocal = { oldName: newName };",
        "  return x + Object.keys(oldNameLocal).length;",
        "}",
        "export const other = newName(1);",
      ),
    );
  });

  it("renames imports and their uses, and lists what it cannot follow", () => {
    const plan = rename("src/a/source.ts", "oldName", "newName");

    expect(read("src/b/user.ts")).toBe(
      lines(
        'import { newName, other } from "../a/source.js";',
        'import { newName as aliased } from "@/a/source.js";',
        'import * as ns from "../a/source.js";',
        'export type T = ReturnType<typeof import("../a/source.js").newName>;',
        'rs.mock("../a/source.js", () => ({}));',
        "export const all = [newName(2), aliased, ns.newName, other, { oldName: newName }];",
        "export { newName };",
      ),
    );
    expect(plan.review).toEqual([expect.stringMatching(/^pkg\/src\/b\/user\.ts:5: rs\.mock/)]);
  });

  it("follows the name through every kind of re-export", () => {
    rename("src/a/source.ts", "oldName", "newName");

    expect(read("src/a/index.ts")).toBe('export * from "./source.js";\n');
    expect(read("src/a/named.ts")).toBe('export { newName } from "./source.js";\n');
    for (const f of ["via-barrel", "via-named", "via-user"]) {
      expect(read(`src/b/${f}.ts`)).toContain("export const v = newName;");
    }
  });

  it("refuses a name a touched file already declares", () => {
    write(
      "src/b/clash.ts",
      'import { oldName } from "../a/source.js";\nconst newName = oldName;\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: root });

    expect(() =>
      planRename(root, { file: pkg("src/a/source.ts"), from: "oldName", to: "newName" }),
    ).toThrow(/clash\.ts already declares newName/);
  });

  it("refuses a name the file does not declare at the top", () => {
    expect(() => planRename(root, { file: pkg("src/a/source.ts"), from: "x", to: "y" })).toThrow(
      /x is not declared at the top/,
    );
  });
});
