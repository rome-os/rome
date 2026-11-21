// A connection reports what the platform said and nothing it would have to
// decide. Whom a message addresses, and whether its sender counts as a bot to
// Rome, is worked out above it: docs/domains/connections.md#message.
//
// This test reads every source file under connections/ with the TypeScript
// parser and fails on any identifier, property name or string that names the
// fields apps receive for that decision. Comments do not count.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import ts from "typescript";

const CONNECTIONS = dirname(fileURLToPath(import.meta.url));

/** The names a connection never uses: the decisions apps receive, and their type. */
const DECIDED_ABOVE = new Set(["addressing", "fromBot", "mentionsOthers", "MessageAddressing"]);

/** Test support rebuilds old fixtures from these names, so it is left out. */
function isSource(path: string): boolean {
  return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith("test-fixtures.ts");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return isSource(path) ? [path] : [];
  });
}

/** Every use of a name in DECIDED_ABOVE in `text`, as `name:line used`. */
function decisionsInText(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const text =
      ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : null;
    if (text !== null && DECIDED_ABOVE.has(text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${name}:${line + 1} ${text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function decisionsIn(path: string): string[] {
  return decisionsInText(relative(CONNECTIONS, path), readFileSync(path, "utf8"));
}

describe("a connection's message", () => {
  const files = sourceFiles(CONNECTIONS);

  it("reads the connection sources", () => {
    expect(files.some((path) => path.endsWith(join("kinds", "discord", "discord.ts")))).toBe(true);
  });

  it("catches a decision however it is spelled, and not in a comment", () => {
    const planted = [
      "// addressing is decided above",
      'import type { MessageAddressing } from "@rome-os/app-runtime";',
      'const m = { addressing: "mention", ["fromBot"]: true };',
      "if (m.mentionsOthers) {}",
    ].join("\n");
    expect(decisionsInText("x.ts", planted)).toEqual([
      "x.ts:2 MessageAddressing",
      "x.ts:3 addressing",
      "x.ts:3 fromBot",
      "x.ts:4 mentionsOthers",
    ]);
  });

  it("never names addressing, fromBot or mentionsOthers in connections/", () => {
    expect(files.flatMap(decisionsIn)).toEqual([]);
  });
});
