import { describe, expect, it } from "@rstest/core";
import { tree } from "./fixture.js";
import { forbidImports, importSpecifiers, resolveSpecifier, targetMatches } from "./imports.js";

describe("importSpecifiers", () => {
  it.each([
    ['import a from "x";', ["x"]],
    ["import { a, b as c } from 'x'", ["x"]],
    ['import * as ns from "x"', ["x"]],
    ['import a, { b } from "x"', ["x"]],
    ['import type { T } from "x"', ["x"]],
    ['import { type T, a } from "x"', ["x"]],
    ['export * from "x"', ["x"]],
    ['export * as ns from "x"', ["x"]],
    ['export { a, b as default } from "x"', ["x"]],
    ['export type { T } from "x"', ["x"]],
    ['import "x";', ["x"]],
    ['const m = await import("x");', ["x"]],
    ['const m = import ( "x" , { with: { type: "json" } })', ["x"]],
    ["import {\n  a,\n  b,\n} from \"x\"\nimport c from 'y'", ["x", "y"]],
    ['import { from } from "x"', ["x"]],
  ])("reads %j", (src, want) => {
    expect(importSpecifiers(src)).toEqual(want);
  });

  it.each([
    ['// import a from "x"'],
    ['/* import a from "x" */'],
    ['/**\n * import("x")\n */'],
    ["const s = \"import a from 'x'\";"],
    ["const t = `import a from 'x'`;"],
    ["const m = import(name);"],
    ["const m = import(`x`);"],
    ["const u = import.meta.url;"],
    ['export const from = "x";'],
    ['export function f() { return a.from("x"); }'],
    ['obj.import("x");'],
    ['const r = /import "x"/;'],
  ])("finds no import in %j", (src) => {
    expect(importSpecifiers(src)).toEqual([]);
  });

  it("keeps reading code after a template literal with nested braces", () => {
    const src = 'const t = `a ${ {b: 1}.b } c ${`d ${e}`}`;\nimport x from "after";';
    expect(importSpecifiers(src)).toEqual(["after"]);
  });

  it("tells a division from a regular expression", () => {
    const src = 'const a = b / c; const d = e / f;\nimport x from "y";';
    expect(importSpecifiers(src)).toEqual(["y"]);
  });

  it("does not let a comment containing a quote hide the next import", () => {
    expect(importSpecifiers('// it\'s here\nimport x from "y";')).toEqual(["y"]);
  });
});

describe("resolveSpecifier", () => {
  const aliases: [string, string][] = [
    ["@/core/", "packages/core/"],
    ["@/", "packages/core/src/"],
  ];
  it.each([
    ["a/b/c.ts", "./d.js", "a/b/d.js"],
    ["a/b/c.ts", "../d", "a/d"],
    ["a/b/c.ts", "../../x/y.ts", "x/y.ts"],
    ["a/b/c.ts", ".", "a/b"],
    ["a/b/c.ts", "..", "a"],
    ["a/c.ts", "@/x/y.js", "packages/core/src/x/y.js"],
    ["a/c.ts", "@/core/x.js", "packages/core/x.js"],
    ["a/c.ts", "hono", undefined],
    ["a/c.ts", "@scope/pkg", undefined],
    ["a/c.ts", "node:fs", undefined],
  ])("from %s, %s is %s", (file, spec, want) => {
    expect(resolveSpecifier(file, spec, aliases)).toBe(want);
  });
});

describe("targetMatches", () => {
  it.each([
    ["src/core/a.js", ["src/core/a.ts"], true],
    ["src/core/a.js", ["src/core/a.tsx"], true],
    ["src/core/a.js", ["src/core/a.js"], true],
    ["src/core/a.mjs", ["src/core/a.mts"], true],
    ["src/core/a.mjs", ["src/core/a.ts"], false],
    ["src/core/a", ["src/core/a.ts"], true],
    ["src/core/a", ["src/core/a.tsx"], true],
    ["src/core/a", ["src/core/a/index.ts"], true],
    ["src/core/a", ["src/core/a/index.tsx"], false],
    ["src/core/a.json", ["src/core/a.ts"], false],
    ["src/core/a.js", ["src/core/**"], true],
    ["src/other/a.js", ["src/core/**"], false],
  ])("%s against %j is %s", (target, globs, want) => {
    expect(targetMatches(target, globs)).toBe(want);
  });
});

describe("forbidImports", () => {
  const root = tree({
    "src/app/a.ts": [
      'import { x } from "../core/x.js";',
      'import { x2 } from "../core/x.js";',
      'import type { T } from "@/core/types";',
      'export * from "../core/z.mjs";',
      'import "../ok/fine.js";',
      'import pkg from "hono";',
      '// import { y } from "../core/y.js";',
      'const m = await import("../core/dyn.js");',
    ].join("\n"),
    "src/app/b.tsx": 'import { x } from "../core/x.js";',
    "src/app/c.mjs": 'import { x } from "../core/m.mjs";',
    "src/app/d.js": 'import { x } from "../core";',
    "src/app/e.json": '{"import": "../core/x.js"}',
    "src/app/exempt.ts": 'import { x } from "../core/x.js";',
    "src/app/node_modules/dep/index.ts": 'import { x } from "../../../core/x.js";',
    "src/core/x.ts": 'import { a } from "../app/a.js";',
    "other/f.ts": 'import { x } from "../src/core/x.js";',
  });
  const check = forbidImports({
    name: "no-app-imports-core",
    description: "No app imports core.",
    from: ["src/app/**"],
    to: ["src/core/**"],
    except: ["src/app/exempt.ts"],
    aliases: { "@/": "src/" },
  });

  it("reports one sorted line per importing file and resolved target", async () => {
    expect(await check.violations({ root })).toEqual([
      "src/app/a.ts: imports src/core/dyn.js",
      "src/app/a.ts: imports src/core/types",
      "src/app/a.ts: imports src/core/x.js",
      "src/app/a.ts: imports src/core/z.mjs",
      "src/app/b.tsx: imports src/core/x.js",
      "src/app/c.mjs: imports src/core/m.mjs",
      "src/app/d.js: imports src/core",
    ]);
  });

  it("carries the name and description", () => {
    expect(check.name).toBe("no-app-imports-core");
    expect(check.description).toBe("No app imports core.");
  });

  it("matches a target only through the source-file readings of its extension", async () => {
    const r = tree({
      "app/a.ts": [
        'import "../core/a.js";',
        'import "../core/b";',
        'import "../core/c.mjs";',
        'import "../core/d.json";',
      ].join("\n"),
    });
    const only = (to: string[]) =>
      forbidImports({ name: "n", description: "d", from: ["app/*.ts"], to }).violations({
        root: r,
      });
    expect(await only(["core/a.ts"])).toEqual(["app/a.ts: imports core/a.js"]);
    expect(await only(["core/b/index.ts"])).toEqual(["app/a.ts: imports core/b"]);
    expect(await only(["core/c.mts"])).toEqual(["app/a.ts: imports core/c.mjs"]);
    expect(await only(["core/d.ts"])).toEqual([]);
  });

  it("scans the whole tree for a from glob that starts with **", async () => {
    const r = tree({ "a/b/c.ts": 'import "../../core/x.js";', "d.ts": 'import "./core/x.js";' });
    const c = forbidImports({ name: "n", description: "d", from: ["**/*.ts"], to: ["core/**"] });
    expect(await c.violations({ root: r })).toEqual([
      "a/b/c.ts: imports core/x.js",
      "d.ts: imports core/x.js",
    ]);
  });

  it("finds nothing when no file matches a from glob", async () => {
    const c = forbidImports({ name: "n", description: "d", from: ["missing/**"], to: ["**"] });
    expect(await c.violations({ root })).toEqual([]);
  });
});
