import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { planUnusedImports } from "./remove-unused-imports.js";

let root: string;
const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

function prune(name: string, text: string): { text: string | undefined; removed: number } {
  const file = join(root, name);
  writeFileSync(file, text);
  const plan = planUnusedImports([file]);
  return { text: plan.edits.get(file), removed: plan.removed };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "remove-unused-imports-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("planUnusedImports", () => {
  it("drops unused bindings and declarations, and keeps every kind of use", () => {
    const result = prune(
      "a.tsx",
      lines(
        'import React, { useState, useEffect as unusedEffect } from "react";',
        'import type { A, B } from "./types.js";',
        'import * as ns from "./ns.js";',
        'import * as unusedNs from "./ns2.js";',
        'import data from "./d.json" with { type: "json" };',
        'import gone from "./gone.js";',
        'import { linked } from "./linked.js";',
        'import { shorthand, reexp, shadowed, Widget, typed } from "./x.js";',
        'import {} from "./side.js";',
        'import "./side2.js";',
        "",
        "/** See {@link linked}. */",
        "export function f(shadowed: number): B {",
        "  const o = { shorthand };",
        "  useState(ns.x);",
        "  const t: typeof typed = 1;",
        "  return <Widget value={o} /> as unknown as B;",
        "}",
        "export { reexp };",
        "export const d = data;",
      ),
    );

    expect(result.removed).toBe(6);
    expect(result.text).toBe(
      lines(
        'import { useState } from "react";',
        'import type { B } from "./types.js";',
        'import * as ns from "./ns.js";',
        'import data from "./d.json" with { type: "json" };',
        'import { linked } from "./linked.js";',
        'import { shorthand, reexp, Widget, typed } from "./x.js";',
        'import {} from "./side.js";',
        'import "./side2.js";',
        "",
        "/** See {@link linked}. */",
        "export function f(shadowed: number): B {",
        "  const o = { shorthand };",
        "  useState(ns.x);",
        "  const t: typeof typed = 1;",
        "  return <Widget value={o} /> as unknown as B;",
        "}",
        "export { reexp };",
        "export const d = data;",
      ),
    );
  });

  it("leaves a file whose imports are all used", () => {
    const result = prune("b.ts", lines('import { x } from "./x.js";', "export const y = x;"));

    expect(result).toEqual({ text: undefined, removed: 0 });
  });
});
