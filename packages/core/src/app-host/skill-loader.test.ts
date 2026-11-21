import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "@rstest/core";
import { listCompanionFiles } from "./skill-loader.js";

describe("listCompanionFiles", () => {
  it("lists every visible file beside SKILL.md, sorted, with nested paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-companions-"));
    try {
      await writeFile(join(dir, "SKILL.md"), "---\nname: a\ndescription: b\n---");
      await writeFile(join(dir, "SHARING.md"), "x");
      await writeFile(join(dir, "PUBLISHING.md"), "x");
      await mkdir(join(dir, "music"));
      await writeFile(join(dir, "music", "track.md"), "x");
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(dir, "node_modules", "pkg", "index.js"), "x");
      await writeFile(join(dir, ".env"), "SECRET=x");
      await mkdir(join(dir, ".git"));
      await writeFile(join(dir, ".git", "HEAD"), "x");

      expect(await listCompanionFiles(dir)).toEqual([
        "PUBLISHING.md",
        "SHARING.md",
        "music/track.md",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a SKILL.md-only or missing directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-companions-"));
    try {
      await writeFile(join(dir, "SKILL.md"), "x");
      expect(await listCompanionFiles(dir)).toEqual([]);
      expect(await listCompanionFiles(join(dir, "missing"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
