import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PROJECTS_SEARCH_GLOBS } from "./project-entry-policy.js";
import { createSearchHandler } from "./file-browser-server.js";

function importLog(rowCount: number): string {
  return Array.from(
    { length: rowCount },
    (_, index) =>
      `2026-10-15T09:00:00.000Z INFO worker: completed import row ${String(index + 1).padStart(6, "0")} batch=daily source=records.csv result=accepted durationMs=12\n`,
  ).join("");
}

describe("Projects file search result limit", () => {
  let rootDir: string;
  let app: Hono;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "rome-file-search-"));
    mkdirSync(join(rootDir, "daily-import"));
    app = new Hono().get(
      "/projects/search",
      createSearchHandler({
        assetBasePath: "/projects/asset",
        logicalRoot: "projects",
        rootDir,
        searchGlobs: PROJECTS_SEARCH_GLOBS,
      }),
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns the first 100 matches from a small log", async () => {
    const content = importLog(150);
    writeFileSync(join(rootDir, "daily-import", "import.log"), content);

    const response = await app.request("/projects/search?q=INFO");

    expect(response.status).toBe(200);
    const results = await response.json();
    expect(results).toHaveLength(100);
    expect(results[0]).toEqual({
      content: content.split("\n")[0],
      file: "projects/daily-import/import.log",
      line: 1,
    });
    expect(results[99].line).toBe(100);
  });

  it("finds a rare term in a log larger than the subprocess output buffer", async () => {
    const errorLine = "2026-10-15T09:01:00.000Z ERROR worker: import row 012001 failed validation";
    writeFileSync(
      join(rootDir, "daily-import", "import.log"),
      `${importLog(12_000)}${errorLine}\n`,
    );

    const response = await app.request("/projects/search?q=ERROR");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { content: errorLine, file: "projects/daily-import/import.log", line: 12_001 },
    ]);
  });

  it("returns 100 matches when a common term exceeds the subprocess output buffer", async () => {
    const content = importLog(12_000);
    writeFileSync(join(rootDir, "daily-import", "import.log"), content);

    const response = await app.request("/projects/search?q=INFO");

    expect(response.status).toBe(200);
    const results = await response.json();
    expect(results).toHaveLength(100);
    expect(results[0]).toEqual({
      content: content.split("\n")[0],
      file: "projects/daily-import/import.log",
      line: 1,
    });
    expect(results[99].line).toBe(100);
  });

  it("returns bounded snippets for a matching line larger than the output budget", async () => {
    writeFileSync(
      join(rootDir, "daily-import", "bundle.js"),
      `${"a".repeat(1_000_000)}INFO${"b".repeat(1_000_000)}\n`,
    );
    writeFileSync(join(rootDir, "daily-import", "normal.log"), "INFO normal match\n");

    const response = await app.request("/projects/search?q=INFO");

    expect(response.status).toBe(200);
    const results = (await response.json()) as Array<{
      content: string;
      file: string;
      line: number;
    }>;
    expect(results).toHaveLength(2);
    expect(results).toContainEqual({
      content: "INFO normal match",
      file: "projects/daily-import/normal.log",
      line: 1,
    });
    const longLineResult = results.find(
      (result) => result.file === "projects/daily-import/bundle.js",
    );
    expect(longLineResult).toBeDefined();
    expect(longLineResult!.line).toBe(1);
    expect(longLineResult!.content.length).toBeGreaterThan(0);
    expect(longLineResult!.content.length).toBeLessThan(1_000);
  });

  it("limits matches across files without buffering all their output", async () => {
    const content = importLog(75);
    for (let index = 0; index < 160; index++) {
      writeFileSync(
        join(rootDir, "daily-import", `batch-${String(index).padStart(3, "0")}.log`),
        content,
      );
    }

    const response = await app.request("/projects/search?q=INFO");

    expect(response.status).toBe(200);
    const results = (await response.json()) as Array<{
      content: string;
      file: string;
      line: number;
    }>;
    expect(results).toHaveLength(100);
    expect(new Set(results.map((result) => result.file)).size).toBeGreaterThan(1);
    for (const result of results) {
      expect(result.file).toMatch(/^projects\/daily-import\/batch-\d{3}\.log$/);
      expect(result.line).toBeGreaterThanOrEqual(1);
      expect(result.line).toBeLessThanOrEqual(75);
      expect(result.content).toBe(content.split("\n")[result.line - 1]);
    }
  });

  it("returns an empty array when rg finds no matches", async () => {
    writeFileSync(join(rootDir, "daily-import", "import.log"), importLog(150));

    const response = await app.request("/projects/search?q=missing");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns 500 when the real rg rejects a search glob", async () => {
    app = new Hono().get(
      "/projects/search",
      createSearchHandler({
        assetBasePath: "/projects/asset",
        logicalRoot: "projects",
        rootDir,
        searchGlobs: ["["],
      }),
    );

    const response = await app.request("/projects/search?q=INFO");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to search files" });
  });

  it("preserves Unicode and the last file line without a trailing newline", async () => {
    writeFileSync(join(rootDir, "daily-import", "笔记.txt"), "说明：导入完成");

    const response = await app.request(`/projects/search?q=${encodeURIComponent("导入")}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { content: "说明：导入完成", file: "projects/daily-import/笔记.txt", line: 1 },
    ]);
  });
});
