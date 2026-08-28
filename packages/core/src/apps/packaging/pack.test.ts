import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { buildSourceWorkspace, packArtifact } from "./pack.js";
import { hashArtifact } from "./hash.js";
import {
  classifyAppDir,
  PACKED_ARTIFACT_SENTINEL,
  sourceRootForArtifactPath,
} from "./recognition.js";

const VALID_ACTION_YAML = [
  "name: ping",
  "type: custom",
  "description: ping",
  "complexity: simple",
  "speed: fast",
  "reliability: high",
  "sideEffects: read-only",
  "",
].join("\n");

const VALID_AGENT_YAML = [
  "name: demo",
  "description: demo agent",
  "tier: small",
  "systemPromptPrefix: You are a demo agent.",
  "tools:",
  "  - Read",
  "permissionMode: default",
  "",
].join("\n");

function writeMinimalAppSource(sourceRoot: string, appId: string): void {
  writeFileSync(
    join(sourceRoot, "app.yaml"),
    [
      `formatVersion: 1`,
      `id: ${JSON.stringify(appId)}`,
      `version: 0.0.1`,
      `description: test app`,
      `actions:`,
      `  - actions/ping`,
      ``,
    ].join("\n"),
    "utf-8",
  );
  mkdirSync(join(sourceRoot, "actions", "ping"), { recursive: true });
  writeFileSync(join(sourceRoot, "actions", "ping", "action.yaml"), VALID_ACTION_YAML, "utf-8");
}

function setIncludeSource(sourceRoot: string, value: boolean): void {
  const manifestPath = join(sourceRoot, "app.yaml");
  const manifest = readFileSync(manifestPath, "utf-8");
  writeFileSync(manifestPath, `${manifest}includeSource: ${value}\n`, "utf-8");
}

describe("packArtifact", () => {
  let workDir: string;
  let sourceRoot: string;
  let outDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "rome-pack-"));
    sourceRoot = join(workDir, "src");
    outDir = join(workDir, "out");
    mkdirSync(sourceRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("packs an app source without installing deps", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");

    const result = await packArtifact(sourceRoot, outDir);

    expect(result).toEqual({
      appId: "pack-test",
      version: "0.0.1",
      outDir,
    });
    expect(existsSync(join(outDir, "app.yaml"))).toBe(true);
    expect(existsSync(join(outDir, "actions", "ping", "action.yaml"))).toBe(true);
    expect(existsSync(join(outDir, "node_modules"))).toBe(false);
  });

  it("packs a scoped app id without treating its slash as a temp-directory boundary", async () => {
    writeMinimalAppSource(sourceRoot, "@foo/bar");

    const result = await packArtifact(sourceRoot, outDir);

    expect(result.appId).toBe("@foo/bar");
    expect(existsSync(join(outDir, "app.yaml"))).toBe(true);
  });

  it("includes the complete src tree when includeSource is true", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    setIncludeSource(sourceRoot, true);
    mkdirSync(join(sourceRoot, "src", "nested"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(sourceRoot, "src", "nested", "index.test.ts"), "export {};\n");
    writeFileSync(join(sourceRoot, "src", "types.d.ts"), "export type Value = number;\n");
    writeFileSync(join(sourceRoot, "src", ".Env.Example"), "TOKEN=replace-me\n");

    await packArtifact(sourceRoot, outDir);

    expect(readFileSync(join(outDir, "src", "index.ts"), "utf-8")).toContain("value = 1");
    expect(existsSync(join(outDir, "src", "nested", "index.test.ts"))).toBe(true);
    expect(existsSync(join(outDir, "src", "types.d.ts"))).toBe(true);
    expect(existsSync(join(outDir, "src", ".Env.Example"))).toBe(true);
    expect(classifyAppDir(outDir)).toBe("bundle");
  });

  it("omits src when includeSource is false or absent", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "index.ts"), "export {};\n");

    await packArtifact(sourceRoot, outDir);
    expect(existsSync(join(outDir, "src"))).toBe(false);

    setIncludeSource(sourceRoot, false);
    await packArtifact(sourceRoot, outDir, { clean: true });
    expect(existsSync(join(outDir, "src"))).toBe(false);
  });

  it("requires a src directory when includeSource is true", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    setIncludeSource(sourceRoot, true);

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/includeSource: true/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("makes included source part of the artifact hash", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    setIncludeSource(sourceRoot, true);
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    const sourceFile = join(sourceRoot, "src", "index.ts");
    writeFileSync(sourceFile, "export const value = 1;\n");

    await packArtifact(sourceRoot, outDir);
    const firstHash = await hashArtifact(outDir);
    writeFileSync(sourceFile, "export const value = 2;\n");
    await packArtifact(sourceRoot, outDir, { clean: true });

    expect(await hashArtifact(outDir)).not.toBe(firstHash);
  });

  it("rejects secret files in published source", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    setIncludeSource(sourceRoot, true);
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", ".env.local"), "TOKEN=secret\n");

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/\.env\.local/);
    expect(existsSync(outDir)).toBe(false);

    rmSync(join(sourceRoot, "src", ".env.local"));
    writeFileSync(join(sourceRoot, "src", ".Env.production"), "TOKEN=secret\n");
    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/\.Env\.production/);
    expect(existsSync(outDir)).toBe(false);

    rmSync(join(sourceRoot, "src", ".Env.production"));
    writeFileSync(join(sourceRoot, "src", "server.key"), "private key\n");
    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/server\.key/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects symbolic links in published source", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    setIncludeSource(sourceRoot, true);
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "outside.ts"), "export const secret = true;\n");
    symlinkSync(join(sourceRoot, "outside.ts"), join(sourceRoot, "src", "linked.ts"));

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/symbolic links/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("keeps .rome_store metadata out of the packed runtime artifact", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    mkdirSync(join(sourceRoot, ".rome_store", "assets"), { recursive: true });
    writeFileSync(join(sourceRoot, ".rome_store", "rome_store.yaml"), "title: Pack Test\n");
    writeFileSync(join(sourceRoot, ".rome_store", "assets", "store-og.png"), "fake", "utf-8");

    await packArtifact(sourceRoot, outDir);

    expect(existsSync(join(outDir, ".rome_store"))).toBe(false);
  });

  it("a packed artifact of a workspace with pnpm-workspace.yaml still classifies as bundle", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(join(sourceRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf-8");
    mkdirSync(join(sourceRoot, "src"));

    await packArtifact(sourceRoot, outDir);

    // The no-appRoot snapshot keeps pnpm-workspace.yaml (it isolates the
    // bundle's prod-deps install), so it must not flip the shape check:
    // a `mode: "bundle"` re-install of this artifact has to pass.
    expect(existsSync(join(outDir, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(outDir, "src"))).toBe(false);
    expect(classifyAppDir(outDir)).toBe("bundle");
  });

  it("keeps pnpm build approvals when packing an appRoot artifact", async () => {
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        `formatVersion: 1`,
        `id: pack-approvals`,
        `version: 0.0.1`,
        `description: test app`,
        `appRoot: dist`,
        `actions:`,
        `  - actions/ping`,
        ``,
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(sourceRoot, "pnpm-workspace.yaml"),
      'allowBuilds:\n  "rome-fixture-build-dep@file:dist/build-dep": true\n',
      "utf-8",
    );
    mkdirSync(join(sourceRoot, "dist", "actions", "ping"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "dist", "actions", "ping", "action.yaml"),
      VALID_ACTION_YAML,
      "utf-8",
    );

    await packArtifact(sourceRoot, outDir);

    expect(existsSync(join(outDir, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("keeps src beside a declared appRoot when source publishing is enabled", async () => {
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        "formatVersion: 1",
        "id: source-app-root",
        "version: 0.0.1",
        "description: test app",
        "appRoot: dist",
        "includeSource: true",
        "actions:",
        "  - actions/ping",
        "",
      ].join("\n"),
    );
    mkdirSync(join(sourceRoot, "dist", "actions", "ping"), { recursive: true });
    writeFileSync(join(sourceRoot, "dist", "actions", "ping", "action.yaml"), VALID_ACTION_YAML);
    mkdirSync(join(sourceRoot, "src", "actions", "ping"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "actions", "ping", "index.ts"), "export {};\n");

    await packArtifact(sourceRoot, outDir);

    expect(existsSync(join(outDir, "dist", "actions", "ping", "action.yaml"))).toBe(true);
    expect(existsSync(join(outDir, "src", "actions", "ping", "index.ts"))).toBe(true);
  });

  it("a failed re-pack with clean keeps the previous artifact intact", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    await packArtifact(sourceRoot, outDir);
    expect(existsSync(join(outDir, "app.yaml"))).toBe(true);

    // Break the source so the snapshot pipeline fails (manifest declares an
    // action dir that does not exist), then re-pack with clean: the old
    // artifact is still the pinned artifact for the installed hash and must
    // survive a pack that never produced a replacement.
    await rm(join(sourceRoot, "actions"), { recursive: true, force: true });
    await expect(packArtifact(sourceRoot, outDir, { clean: true })).rejects.toThrow();

    expect(existsSync(join(outDir, "app.yaml"))).toBe(true);
    expect(existsSync(join(outDir, "actions", "ping", "action.yaml"))).toBe(true);
    expect(classifyAppDir(outDir)).toBe("bundle");
  });

  it("rejects when the manifest id doesn't match options.appId", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");

    await expect(packArtifact(sourceRoot, outDir, { appId: "other-id" })).rejects.toThrow(
      /does not match pack target "other-id"/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses to overwrite a non-empty out dir", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "leftover"), "stale", "utf-8");

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/not empty/);
    expect(existsSync(join(outDir, "leftover"))).toBe(true);
  });

  it("with clean:true, wipes a non-empty out dir before re-packing", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "stale-leftover"), "old", "utf-8");

    const result = await packArtifact(sourceRoot, outDir, { clean: true });

    expect(result.outDir).toBe(outDir);
    expect(existsSync(join(outDir, "app.yaml"))).toBe(true);
    expect(existsSync(join(outDir, "stale-leftover"))).toBe(false);
  });

  it("cleans up the out dir if validation fails", async () => {
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        `formatVersion: 1`,
        `id: pack-test`,
        `version: 0.0.1`,
        `description: test app`,
        `actions:`,
        `  - actions/missing`,
        ``,
      ].join("\n"),
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/missing action at/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects a manifest without formatVersion", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      ["id: pack-test", "version: 0.0.1", "description: test app", ""].join("\n"),
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/formatVersion/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects a manifest with an unsupported formatVersion", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      ["formatVersion: 3", "id: pack-test", "version: 0.0.1", "description: test app", ""].join(
        "\n",
      ),
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/formatVersion/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects a manifest with an unknown field", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        "formatVersion: 1",
        "id: pack-test",
        "version: 0.0.1",
        "description: test app",
        "futureFeature: true",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/futureFeature/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("accepts the strict remix lineage shape and preserves it in the bundle", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    const manifestPath = join(sourceRoot, "app.yaml");
    writeFileSync(
      manifestPath,
      `${readFileSync(manifestPath, "utf-8")}remix:\n  listing: "@alice/calendar"\n  version: 1.2.3\n`,
      "utf-8",
    );

    await packArtifact(sourceRoot, outDir);

    expect(readFileSync(join(outDir, "app.yaml"), "utf-8")).toContain(
      'remix:\n  listing: "@alice/calendar"\n  version: 1.2.3',
    );
  });

  it("rejects unknown remix lineage fields under the strict manifest schema", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    const manifestPath = join(sourceRoot, "app.yaml");
    writeFileSync(
      manifestPath,
      `${readFileSync(manifestPath, "utf-8")}remix:\n  listing: "@alice/calendar"\n  version: 1.2.3\n  appId: calendar\n`,
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(
      /remix: Unrecognized key.*appId/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects a v2 manifest publicName that differs from the definition name", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        "formatVersion: 2",
        "id: pack-test",
        "version: 0.0.1",
        "description: test app",
        "actions:",
        "  - path: actions/ping",
        "    publicName: pong",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/they must match/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects a manifest whose id violates the app-id grammar", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      ["formatVersion: 1", "id: My App", "version: 0.0.1", "description: test app", ""].join("\n"),
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(
      /unscoped lowercase slug or a scoped App Store id/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it.each([
    1, 2,
  ] as const)("rejects an App agent named main in format version %s", async (formatVersion) => {
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        `formatVersion: ${formatVersion}`,
        "id: pack-test",
        "version: 0.0.1",
        "description: test app",
        "agents:",
        formatVersion === 2 ? "  - path: agents/main.yaml" : "  - agents/main.yaml",
        "",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(sourceRoot, "agents"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "agents", "main.yaml"),
      VALID_AGENT_YAML.replace("name: demo", "name: main"),
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(
      /only Rome Core may define the main agent/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects an agent yaml with an unknown field inside an mcpServers entry", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        "formatVersion: 1",
        "id: pack-test",
        "version: 0.0.1",
        "description: test app",
        "agents:",
        "  - agents/demo.yaml",
        "",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(sourceRoot, "agents"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "agents", "demo.yaml"),
      [
        VALID_AGENT_YAML.trimEnd(),
        "mcpServers:",
        "  browser:",
        "    command: npx",
        "    args: []",
        "    env:",
        "      FOO: bar",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/env/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects an action.yaml with an unknown field", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "actions", "ping", "action.yaml"),
      `${VALID_ACTION_YAML}timeoutMs: 5000\n`,
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/timeoutMs/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects an agent yaml with an unknown field", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        "formatVersion: 1",
        "id: pack-test",
        "version: 0.0.1",
        "description: test app",
        "agents:",
        "  - agents/demo.yaml",
        "",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(sourceRoot, "agents"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "agents", "demo.yaml"),
      `${VALID_AGENT_YAML}temperature: 0.5\n`,
      "utf-8",
    );

    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/temperature/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("packs an app whose agent yaml matches the schema", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        "formatVersion: 1",
        "id: pack-test",
        "version: 0.0.1",
        "description: test app",
        "agents:",
        "  - agents/demo.yaml",
        "",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(sourceRoot, "agents"), { recursive: true });
    writeFileSync(join(sourceRoot, "agents", "demo.yaml"), VALID_AGENT_YAML, "utf-8");

    const result = await packArtifact(sourceRoot, outDir);

    expect(result.appId).toBe("pack-test");
    expect(existsSync(join(outDir, "agents", "demo.yaml"))).toBe(true);
  });

  it("fails fast when the source has no app.yaml", async () => {
    await expect(packArtifact(sourceRoot, outDir)).rejects.toThrow(/missing app\.yaml/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("packs into a destination nested inside the source tree", async () => {
    // Regression: snapshotIntoStaging walks sourceRoot, so an outDir nested
    // inside sourceRoot (and not under an excluded top-level name like
    // `.rome`) used to recurse into its own output. packArtifact now stages
    // outside the source tree, so any outDir is safe.
    writeMinimalAppSource(sourceRoot, "pack-test");
    const nestedOut = join(sourceRoot, "out");

    const result = await packArtifact(sourceRoot, nestedOut);

    expect(result.outDir).toBe(nestedOut);
    expect(existsSync(join(nestedOut, "app.yaml"))).toBe(true);
    expect(existsSync(join(nestedOut, "actions", "ping", "action.yaml"))).toBe(true);
  });

  it("packs into the default <source>/.rome/artifact path", async () => {
    writeMinimalAppSource(sourceRoot, "pack-test");
    const defaultOut = join(sourceRoot, ".rome", "artifact");

    const result = await packArtifact(sourceRoot, defaultOut);

    expect(existsSync(join(defaultOut, "app.yaml"))).toBe(true);
    expect(result.outDir).toBe(defaultOut);
  });
});

describe("classifyAppDir", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "rome-classify-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("classifies a missing path as missing", () => {
    expect(classifyAppDir(join(workDir, "nope"))).toBe("missing");
  });

  it("classifies a dir without app.yaml as no-manifest", () => {
    expect(classifyAppDir(workDir)).toBe("no-manifest");
  });

  it("classifies an app.yaml dir with a source marker as source", () => {
    writeFileSync(join(workDir, "app.yaml"), "id: x\n", "utf-8");
    mkdirSync(join(workDir, "src"));
    expect(classifyAppDir(workDir)).toBe("source");
  });

  it("classifies an app.yaml dir with a drizzle config as source", () => {
    writeFileSync(join(workDir, "app.yaml"), "id: x\n", "utf-8");
    writeFileSync(join(workDir, "drizzle.config.ts"), "export default {};\n", "utf-8");
    expect(classifyAppDir(workDir)).toBe("source");
  });

  it("classifies a marker-free app.yaml dir as source — bundle needs the pack sentinel", () => {
    // Pure-YAML source repos (a bare actions/ tree, no src/.git/tsconfig)
    // are still source workspaces; only a dir provably produced by
    // packArtifact may be installed as a bundle.
    writeFileSync(join(workDir, "app.yaml"), "id: x\n", "utf-8");
    mkdirSync(join(workDir, "actions"));
    expect(classifyAppDir(workDir)).toBe("source");
  });

  it("classifies a packArtifact output as bundle via the sentinel", async () => {
    const sourceRoot = join(workDir, "src-app");
    const outDir = join(workDir, "out");
    mkdirSync(sourceRoot, { recursive: true });
    writeMinimalAppSource(sourceRoot, "classify-pack");

    await packArtifact(sourceRoot, outDir);

    expect(existsSync(join(outDir, PACKED_ARTIFACT_SENTINEL))).toBe(true);
    expect(classifyAppDir(outDir)).toBe("bundle");
  });
});

describe("sourceRootForArtifactPath", () => {
  it("maps <repo>/.rome/artifact back to <repo>", () => {
    expect(sourceRootForArtifactPath("/home/me/apps/notes/.rome/artifact")).toBe(
      "/home/me/apps/notes",
    );
  });

  it("returns null for paths outside the convention", () => {
    expect(sourceRootForArtifactPath("/home/me/apps/notes")).toBeNull();
    expect(sourceRootForArtifactPath("/home/me/apps/notes/dist/artifact")).toBeNull();
  });
});

describe("buildSourceWorkspace", () => {
  let workDir: string;
  let repo: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "rome-buildsrc-"));
    repo = join(workDir, "member-app");
    mkdirSync(repo, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("is a no-op for a workspace without package.json", async () => {
    await expect(buildSourceWorkspace(repo, { projectRoot: workDir })).resolves.toBeUndefined();
  });

  it("is a no-op when package.json has neither a build script nor deps", async () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x" }), "utf-8");
    await expect(buildSourceWorkspace(repo, { projectRoot: workDir })).resolves.toBeUndefined();
  });

  it("refuses to run pnpm inside a Rome monorepo member, pointing at build:apps", async () => {
    // A workspace member: inside the project root, no pnpm-workspace.yaml of
    // its own. Running pnpm here would install into the monorepo itself.
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
      "utf-8",
    );
    await expect(buildSourceWorkspace(repo, { projectRoot: workDir })).rejects.toThrow(
      /pnpm build:apps/,
    );
  });
});
