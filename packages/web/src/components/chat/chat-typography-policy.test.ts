import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const chatRoot = fileURLToPath(new URL(".", import.meta.url));

function chatSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return chatSourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) && !path.includes(".test.") ? [path] : [];
  });
}

describe("chat typography policy", () => {
  it("uses typography roles without legacy size, weight, or rhythm utilities", () => {
    const declarations = chatSourceFiles(chatRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [
        ...source.matchAll(
          /(?:[a-z0-9_@\[\].-]+:)*(?:text-(?:base|lg|2xl|3xl)|font-(?:medium|semibold|bold|normal|light)|(?:leading|tracking)-(?:\[[^\]]+\]|[a-z0-9.-]+))/gi,
        ),
      ].map((match) => `${relative(chatRoot, path)}:${match[0]}`);
    });

    expect(declarations.sort()).toEqual([
      "ChatEmptyState.tsx:font-normal",
      "ChatEmptyState.tsx:leading-[1.05]",
      "ChatEmptyState.tsx:tracking-[-0.025em]",
      "blocks/SubagentStepBlock.tsx:tracking-wide",
      "blocks/ToolStepBlock.tsx:tracking-wide",
    ]);
  });
});
