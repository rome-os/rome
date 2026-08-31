import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const componentsRoot = fileURLToPath(new URL(".", import.meta.url));
const scopedDirectories = ["file-browser", "sync"];

function sourceFiles(directory: string, recursive: boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return recursive ? sourceFiles(path, true) : [];
    return [".ts", ".tsx"].includes(extname(path)) && !path.includes(".test.") ? [path] : [];
  });
}

describe("components typography policy", () => {
  it("uses typography roles without legacy size, weight, or rhythm utilities", () => {
    const paths = [
      ...sourceFiles(componentsRoot, false),
      ...scopedDirectories.flatMap((directory) =>
        sourceFiles(resolve(componentsRoot, directory), true),
      ),
    ];
    const declarations = paths.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [
        ...source.matchAll(
          /(?:[a-z0-9_@\[\].-]+:)*(?:text-(?:base|lg|2xl|3xl)|font-(?:medium|semibold|bold|normal|light)|(?:leading|tracking)-(?:\[[^\]]+\]|[a-z0-9.-]+))/gi,
        ),
      ].map((match) => `${relative(componentsRoot, path)}:${match[0]}`);
    });

    expect(declarations.sort()).toEqual([]);
  });
});
