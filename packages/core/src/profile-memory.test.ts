import { describe, expect, it, rs, beforeEach } from "@rstest/core";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

rs.mock("./paths.js", () => ({
  getProfileDir: rs.fn(() => "/tmp/profile"),
  getProfileMemoryDir: rs.fn(() => "/tmp/profile/memory"),
  getProjectRoot: rs.fn(() => "/tmp/project"),
  getCoreRoot: rs.fn(() => "/tmp/project/packages/core"),
}));

import { getProfileDir, getProfileMemoryDir, getProjectRoot, getCoreRoot } from "./paths.js";
import {
  ensureProfileMemoryInitialized,
  RELATIONSHIP_DIR,
  resolveProfileMemoryPath,
} from "./profile-memory.js";

const mockedGetProfileDir = rs.mocked(getProfileDir);
const mockedGetProfileMemoryDir = rs.mocked(getProfileMemoryDir);
const mockedGetProjectRoot = rs.mocked(getProjectRoot);
const mockedGetCoreRoot = rs.mocked(getCoreRoot);

// getMemoryTemplateDir() resolves the template relative to getCoreRoot(). This
// test file lives at packages/core/src, so the real core root is two levels up.
const REAL_CORE_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("profile-memory", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });

  // Regression: the template path used to point at the monorepo root, where no
  // `memory.example` exists, so seeding silently no-op'd and fresh profiles came
  // up without MEMORY.md. Source from the REAL packages/core/memory.example to
  // prove the wired-up template actually lands.
  it("seeds the real memory.example template — including MEMORY.md — into a fresh profile", () => {
    const profileDir = createTempDir("profile-memory-real-");
    const profileMemoryDir = join(profileDir, "memory");

    mockedGetCoreRoot.mockReturnValue(REAL_CORE_ROOT);
    mockedGetProfileDir.mockReturnValue(profileDir);
    mockedGetProfileMemoryDir.mockReturnValue(profileMemoryDir);

    ensureProfileMemoryInitialized();

    expect(existsSync(join(profileMemoryDir, "MEMORY.md"))).toBe(true);
    expect(readFileSync(join(profileMemoryDir, "MEMORY.md"), "utf-8")).toContain("Privacy Config");
    // The wider template tree should land too.
    expect(existsSync(join(profileMemoryDir, "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(profileMemoryDir, "relationship", "BONDS.md"))).toBe(true);
  });

  it("copies missing memory files from memory.example into the profile directory", () => {
    const coreRoot = createTempDir("profile-memory-core-");
    const profileDir = createTempDir("profile-memory-profile-");
    const profileMemoryDir = join(profileDir, "memory");

    mockedGetCoreRoot.mockReturnValue(coreRoot);
    mockedGetProfileDir.mockReturnValue(profileDir);
    mockedGetProfileMemoryDir.mockReturnValue(profileMemoryDir);

    const templateDir = join(coreRoot, "memory.example");
    mkdirSync(join(templateDir, "relationship"), { recursive: true });
    mkdirSync(join(templateDir, "projects"), { recursive: true });
    writeFileSync(join(templateDir, "IDENTITY.md"), "# Identity\nTemplate\n");
    writeFileSync(join(templateDir, "relationship", "TEMPLATE.md"), "# Person Template\n");
    writeFileSync(join(templateDir, "projects", "README.md"), "# Project Memory\n");

    ensureProfileMemoryInitialized();

    expect(readFileSync(join(profileMemoryDir, "IDENTITY.md"), "utf-8")).toContain("Template");
    expect(readFileSync(join(profileMemoryDir, "relationship", "TEMPLATE.md"), "utf-8")).toContain(
      "Person Template",
    );
    expect(readFileSync(join(profileMemoryDir, "projects", "README.md"), "utf-8")).toContain(
      "Project Memory",
    );
  });

  it("does not overwrite existing profile memory files", () => {
    const coreRoot = createTempDir("profile-memory-core-");
    const profileDir = createTempDir("profile-memory-profile-");
    const profileMemoryDir = join(profileDir, "memory");

    mockedGetCoreRoot.mockReturnValue(coreRoot);
    mockedGetProfileDir.mockReturnValue(profileDir);
    mockedGetProfileMemoryDir.mockReturnValue(profileMemoryDir);

    mkdirSync(join(coreRoot, "memory.example"), { recursive: true });
    mkdirSync(profileMemoryDir, { recursive: true });

    writeFileSync(join(coreRoot, "memory.example", "IDENTITY.md"), "# Identity\nTemplate\n");
    writeFileSync(join(profileMemoryDir, "IDENTITY.md"), "# Identity\nCustomized\n");

    ensureProfileMemoryInitialized();

    expect(readFileSync(join(profileMemoryDir, "IDENTITY.md"), "utf-8")).toContain("Customized");
  });

  it("initializes the git repo in the memory dir, not the profile root", () => {
    const coreRoot = createTempDir("profile-memory-core-");
    const profileDir = createTempDir("profile-memory-profile-");
    const profileMemoryDir = join(profileDir, "memory");

    mockedGetCoreRoot.mockReturnValue(coreRoot);
    mockedGetProfileDir.mockReturnValue(profileDir);
    mockedGetProfileMemoryDir.mockReturnValue(profileMemoryDir);

    mkdirSync(join(coreRoot, "memory.example"), { recursive: true });

    ensureProfileMemoryInitialized();

    // Memory is its own self-contained repo; the profile root is never git-init'd
    // (so a sync can never push the DB/credentials/projects beside it).
    expect(existsSync(join(profileMemoryDir, ".git"))).toBe(true);
    expect(existsSync(join(profileDir, ".git"))).toBe(false);
  });

  it("repairs a partially created git directory in the memory dir", () => {
    const coreRoot = createTempDir("profile-memory-core-");
    const profileDir = createTempDir("profile-memory-profile-");
    const profileMemoryDir = join(profileDir, "memory");

    mockedGetCoreRoot.mockReturnValue(coreRoot);
    mockedGetProfileDir.mockReturnValue(profileDir);
    mockedGetProfileMemoryDir.mockReturnValue(profileMemoryDir);

    mkdirSync(join(coreRoot, "memory.example"), { recursive: true });
    mkdirSync(join(profileMemoryDir, ".git", "info"), { recursive: true });
    writeFileSync(join(profileMemoryDir, ".git", "description"), "partial repo\n");

    ensureProfileMemoryInitialized();

    expect(existsSync(join(profileMemoryDir, ".git", "HEAD"))).toBe(true);
  });

  it("resolves logical memory paths inside the profile directory", () => {
    const projectRoot = createTempDir("profile-memory-project-");
    const profileDir = createTempDir("profile-memory-profile-");
    const profileMemoryDir = join(profileDir, "memory");

    mockedGetProjectRoot.mockReturnValue(projectRoot);
    mockedGetProfileDir.mockReturnValue(profileDir);
    mockedGetProfileMemoryDir.mockReturnValue(profileMemoryDir);

    expect(resolveProfileMemoryPath("memory/IDENTITY.md")).toBe(
      join(profileDir, "memory", "IDENTITY.md"),
    );
    expect(resolveProfileMemoryPath("CHARTER.md")).toBe(join(projectRoot, "CHARTER.md"));
  });
});

// The package's own source, walked to see who else names the relationship dir.
const SRC_DIR = resolve(fileURLToPath(import.meta.url), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

describe("where relationship profiles live", () => {
  // Onboarding writes the guardian's profile there, the people read answers
  // where a person's is, and webchat reads the guardian's back — each one an
  // address that has to agree with the others. A second copy of the string is
  // not caught by anything: it keeps working once the folder moves, and answers
  // about a file nobody writes any more. So the string lives in this module,
  // and every reader and writer in the package imports it.
  //
  // Tests are excluded: one asserting the convention has to spell it out, or it
  // asserts the constant against itself.
  it("is stated in this module and nowhere else in the package", () => {
    const statedIn = sourceFiles(SRC_DIR)
      .filter((file) => readFileSync(file, "utf-8").includes(RELATIONSHIP_DIR))
      .map((file) => relative(SRC_DIR, file));

    expect(statedIn).toEqual(["profile-memory.ts"]);
  });
});
