import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Parser } from "tar";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { runPublish } from "./publish.js";

async function listTarEntries(bytes: Buffer): Promise<string[]> {
  const entries: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry) => {
        entries.push(entry.path.replace(/\/$/, ""));
        entry.resume();
      },
    });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.end(bytes);
  });
  return entries;
}

describe("rome publish source packaging", () => {
  let workDir: string;
  let appDir: string;
  let outputPath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "rome-cli-publish-"));
    appDir = path.join(workDir, "notes");
    outputPath = path.join(workDir, "notes.tgz");
    await mkdir(appDir, { recursive: true });
    rs.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    rs.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeManifest(includeSource?: boolean | string): Promise<void> {
    const sourceLine =
      includeSource === undefined ? "" : `includeSource: ${String(includeSource)}\n`;
    await writeFile(
      path.join(appDir, "app.yaml"),
      `formatVersion: 1\nid: notes\nversion: 1.2.3\ndescription: Notes\n${sourceLine}`,
    );
  }

  async function dryRun(extraArgs: string[] = []): Promise<string[]> {
    await runPublish([appDir, "--dry-run", "--out", outputPath, ...extraArgs]);
    return listTarEntries(await readFile(outputPath));
  }

  it("includes src and excludes the nested .rome artifact when enabled", async () => {
    await writeManifest(true);
    await mkdir(path.join(appDir, "src"), { recursive: true });
    await writeFile(path.join(appDir, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(appDir, "src", ".Env.Example"), "TOKEN=replace-me\n");
    await mkdir(path.join(appDir, ".rome", "artifact"), { recursive: true });
    await writeFile(path.join(appDir, ".rome", "artifact", "stale.ts"), "stale\n");

    const entries = await dryRun();

    expect(entries).toContain("notes/src/index.ts");
    expect(entries).toContain("notes/src/.Env.Example");
    expect(entries.some((entry) => entry.includes("/.rome/"))).toBe(false);
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("sourceAvailable true"),
    );
  });

  it.each([undefined, false])("omits the root src directory when set to %s", async (value) => {
    await writeManifest(value);
    await mkdir(path.join(appDir, "src"), { recursive: true });
    await writeFile(path.join(appDir, "src", "index.ts"), "export {};\n");
    await mkdir(path.join(appDir, "dist", "assets", "src"), { recursive: true });
    await writeFile(path.join(appDir, "dist", "assets", "src", "logo.txt"), "logo\n");

    const entries = await dryRun();

    expect(entries).not.toContain("notes/src/index.ts");
    expect(entries).toContain("notes/dist/assets/src/logo.txt");
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("sourceAvailable false"),
    );
  });

  it("requires src when includeSource is true", async () => {
    await writeManifest(true);

    await expect(dryRun()).rejects.toThrow(/not a regular directory/);
  });

  it("rejects a non-boolean includeSource value", async () => {
    await writeManifest("yes");

    await expect(dryRun()).rejects.toThrow(/must be a boolean/);
  });

  it("rejects --exclude src when source publishing is enabled", async () => {
    await writeManifest(true);
    await mkdir(path.join(appDir, "src"), { recursive: true });

    await expect(dryRun(["--exclude", "src"])).rejects.toThrow(/--exclude src is not allowed/);
  });

  it("rejects secret files and symbolic links in published source", async () => {
    await writeManifest(true);
    await mkdir(path.join(appDir, "src"), { recursive: true });
    await writeFile(path.join(appDir, "src", ".env.local"), "TOKEN=secret\n");

    await expect(dryRun()).rejects.toThrow(/\.env\.local/);

    await rm(path.join(appDir, "src", ".env.local"));
    await writeFile(path.join(appDir, "src", ".Env.production"), "TOKEN=secret\n");
    await expect(dryRun()).rejects.toThrow(/\.Env\.production/);

    await rm(path.join(appDir, "src", ".Env.production"));
    await writeFile(path.join(appDir, "src", "server.key"), "private key\n");
    await expect(dryRun()).rejects.toThrow(/server\.key/);

    await rm(path.join(appDir, "src", "server.key"));
    await writeFile(path.join(appDir, "outside.ts"), "export {};\n");
    await symlink(path.join(appDir, "outside.ts"), path.join(appDir, "src", "linked.ts"));
    await expect(dryRun()).rejects.toThrow(/symbolic links/);
  });
});
