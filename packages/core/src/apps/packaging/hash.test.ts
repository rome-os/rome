import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { hashArtifact } from "./hash.js";

describe("hashArtifact", () => {
  let workDir: string;
  let artifactRoot: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "rome-artifact-hash-"));
    artifactRoot = join(workDir, "artifact");
    mkdirSync(join(artifactRoot, "dist"), { recursive: true });
    writeFileSync(
      join(artifactRoot, "app.yaml"),
      "formatVersion: 1\nid: hash-test\nversion: 0.0.1\ndescription: test\n",
    );
    writeFileSync(join(artifactRoot, "dist", "index.js"), "export {};\n");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("ignores .rome_store sidecar metadata in runtime artifact identity", async () => {
    const before = await hashArtifact(artifactRoot);
    mkdirSync(join(artifactRoot, ".rome_store", "assets"), { recursive: true });
    writeFileSync(join(artifactRoot, ".rome_store", "rome_store.yaml"), "title: Hash Test\n");
    writeFileSync(join(artifactRoot, ".rome_store", "assets", "hero.png"), "image-bytes\n");

    expect(await hashArtifact(artifactRoot)).toBe(before);
  });
});
