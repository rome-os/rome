import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".css", ".ts", ".tsx"].includes(extname(path)) && !path.includes(".test.")
      ? [path]
      : [];
  });
}

describe("typography policy", () => {
  it("reserves arbitrary utility sizes for the approved hero and artwork", () => {
    const declarations = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/(?:[a-z0-9_@[\].-]+:)*text-\[\d*\.?\d+(?:px|rem)\]/gi)].map(
        (match) => `${relative(sourceRoot, path)}:${match[0]}`,
      );
    });

    expect(declarations.sort()).toEqual([
      "components/chat/ChatEmptyState.tsx:md:text-[3.35rem]",
      "components/chat/ChatEmptyState.tsx:text-[2.65rem]",
      "pages/SettingsTabPage.tsx:text-[10px]",
      "pages/dev/TypographyPage.tsx:md:text-[3.35rem]",
      "pages/dev/TypographyPage.tsx:text-[2.65rem]",
    ]);
  });

  it("binds JavaScript font sizes to a role unless the API is numeric-only", () => {
    const declarations = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/fontSize:\s*(?:"[^"]+"|\d+)/g)].map(
        (match) => `${relative(sourceRoot, path)}:${match[0]}`,
      );
    });

    expect(declarations.sort()).toEqual([
      "components/monaco-file-editor.tsx:fontSize: 13",
      'components/projects/ProjectDashboard.tsx:fontSize: "var(--text-aux)"',
      'pages/SessionsTrendChart.tsx:fontSize: "var(--text-aux)"',
    ]);
  });
});
