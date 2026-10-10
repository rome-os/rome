import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "@rstest/core";
import YAML from "yaml";
import { bumpVersion, upgradeAppVersion } from "./upgrade.js";

describe("bumpVersion", () => {
  it("increments patch versions", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("increments minor versions and resets patch", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  it("increments major versions and resets minor and patch", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("drops prerelease and build metadata on bump", () => {
    expect(bumpVersion("1.2.3-beta.1+build.7", "patch")).toBe("1.2.4");
  });

  it("rejects invalid versions", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow(/must be SemVer/);
    expect(() => bumpVersion("01.2.3", "patch")).toThrow(/must be SemVer/);
  });
});

describe("upgradeAppVersion", () => {
  it("updates the nearest app.yaml version", async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "rome-upgrade-"));
    const childDir = path.join(appDir, "src", "web");
    await writeFile(
      path.join(appDir, "app.yaml"),
      ["formatVersion: 1", "id: example", "version: 0.1.9", "description: Example", ""].join("\n"),
    );
    await mkdir(childDir, { recursive: true });

    const result = await upgradeAppVersion(childDir, "minor");
    const raw = await readFile(path.join(appDir, "app.yaml"), "utf8");
    const parsed = YAML.parse(raw) as { version: string };

    expect(result.previousVersion).toBe("0.1.9");
    expect(result.version).toBe("0.2.0");
    expect(parsed.version).toBe("0.2.0");
  });
});
