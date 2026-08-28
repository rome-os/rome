import { describe, expect, it, rs, beforeEach } from "@rstest/core";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

rs.mock("./paths.js", () => ({
  getExampleAppsDir: rs.fn(() => "/tmp/example_apps"),
  getProfileExampleAppsDir: rs.fn(() => "/tmp/example-apps"),
}));

import { getExampleAppsDir, getProfileExampleAppsDir } from "./paths.js";
import { ensureProfileExampleAppsSeeded } from "./profile-example-apps.js";

const mockedGetExampleAppsDir = rs.mocked(getExampleAppsDir);
const mockedGetProfileExampleAppsDir = rs.mocked(getProfileExampleAppsDir);

// This file lives at packages/core/src — four levels up is the repo root.
const REAL_REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const REAL_EXAMPLE_APPS = join(REAL_REPO_ROOT, "example_apps");

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Build a synthetic example app with an app.yaml plus build/dep dirs to exclude. */
function writeExampleApp(exampleAppsDir: string, appId: string): void {
  const root = join(exampleAppsDir, appId, "src", "workflow");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(exampleAppsDir, appId, "app.yaml"), `id: ${appId}\n`);
  writeFileSync(join(root, "definition.ts"), "export const runWorkflow = () => {};\n");
  // these must NOT be seeded
  mkdirSync(join(exampleAppsDir, appId, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(exampleAppsDir, appId, "node_modules", "left-pad", "index.js"), "x");
  mkdirSync(join(exampleAppsDir, appId, "dist"), { recursive: true });
  writeFileSync(join(exampleAppsDir, appId, "dist", "bundle.js"), "x");
}

describe("profile-example-apps", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });

  it("seeds an example app into the authoring dir, excluding node_modules/dist", () => {
    const exampleAppsDir = createTempDir("ex-src-");
    const authoringRoot = createTempDir("ex-auth-");
    writeExampleApp(exampleAppsDir, "morning-brief");

    mockedGetExampleAppsDir.mockReturnValue(exampleAppsDir);
    mockedGetProfileExampleAppsDir.mockReturnValue(authoringRoot);

    const seeded = ensureProfileExampleAppsSeeded();

    expect(seeded).toEqual(["morning-brief"]);
    const dest = join(authoringRoot, "morning-brief");
    expect(existsSync(join(dest, "app.yaml"))).toBe(true);
    expect(existsSync(join(dest, "src", "workflow", "definition.ts"))).toBe(true);
    // build/dep dirs are excluded
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    expect(existsSync(join(dest, "dist"))).toBe(false);
  });

  it("does not clobber an already-seeded app (copy-if-missing at the dir level)", () => {
    const exampleAppsDir = createTempDir("ex-src-");
    const authoringRoot = createTempDir("ex-auth-");
    writeExampleApp(exampleAppsDir, "morning-brief");

    // guardian already has an edited copy
    const dest = join(authoringRoot, "morning-brief");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "app.yaml"), "id: morning-brief\n# edited by guardian\n");

    mockedGetExampleAppsDir.mockReturnValue(exampleAppsDir);
    mockedGetProfileExampleAppsDir.mockReturnValue(authoringRoot);

    const seeded = ensureProfileExampleAppsSeeded();

    expect(seeded).toEqual([]);
    // the edit is preserved, not overwritten
    expect(existsSync(join(dest, "src", "workflow", "definition.ts"))).toBe(false);
  });

  it("ignores directories without an app.yaml", () => {
    const exampleAppsDir = createTempDir("ex-src-");
    const authoringRoot = createTempDir("ex-auth-");
    mkdirSync(join(exampleAppsDir, "not-an-app"), { recursive: true });
    writeFileSync(join(exampleAppsDir, "README.md"), "# example_apps\n");

    mockedGetExampleAppsDir.mockReturnValue(exampleAppsDir);
    mockedGetProfileExampleAppsDir.mockReturnValue(authoringRoot);

    expect(ensureProfileExampleAppsSeeded()).toEqual([]);
    expect(existsSync(join(authoringRoot, "not-an-app"))).toBe(false);
  });

  it("no-ops gracefully when the example source dir is absent", () => {
    const authoringRoot = createTempDir("ex-auth-");
    mockedGetExampleAppsDir.mockReturnValue(join(tmpdir(), "does-not-exist-example_apps"));
    mockedGetProfileExampleAppsDir.mockReturnValue(authoringRoot);

    expect(ensureProfileExampleAppsSeeded()).toEqual([]);
  });

  // Smoke test against the real example: the move + wiring actually lands the
  // morning-brief workflow source into a fresh authoring dir.
  it("seeds the real example_apps/morning-brief into a fresh authoring dir", () => {
    const authoringRoot = createTempDir("ex-auth-real-");
    mockedGetExampleAppsDir.mockReturnValue(REAL_EXAMPLE_APPS);
    mockedGetProfileExampleAppsDir.mockReturnValue(authoringRoot);

    const seeded = ensureProfileExampleAppsSeeded();

    expect(seeded).toContain("morning-brief");
    const dest = join(authoringRoot, "morning-brief");
    expect(existsSync(join(dest, "app.yaml"))).toBe(true);
    expect(existsSync(join(dest, "src", "workflow", "definition.ts"))).toBe(true);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
  });
});
