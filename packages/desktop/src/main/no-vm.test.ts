import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "@rstest/core";

// The app used to bundle Lima and boot a VM. It now only opens Rome Cloud, and
// these keep the VM's payload, signing step and launcher from coming back.
const packageDir = join(__dirname, "..", "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("the Mac app without a VM", () => {
  it("bundles no Lima payload and only skips re-signing the pre-signed computer-use helper", () => {
    const config = readFileSync(join(packageDir, "electron-builder.yml"), "utf8");
    expect(config).not.toMatch(/lima|beforePack|afterPack/i);
    expect(config.match(/signIgnore/gi)).toHaveLength(1);
    const signIgnoreBlock = config.match(/^  signIgnore:\n((?:    - .*\n)+)/m);
    expect(
      signIgnoreBlock?.[1]
        .trim()
        .split("\n")
        .map((line) => line.trim()),
    ).toEqual(["- '/Contents/Resources/native/Rome Computer Use\\.app(?:/|$)'"]);
    expect(config).toContain('"!**/node_modules/@rome-os/node-core-darwin-arm64/**"');
  });

  it("has no build script for a VM image", () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(Object.keys(pkg.scripts)).not.toContain("image:local");
    expect(Object.keys(pkg.scripts)).not.toContain("smoke:guest-image");
  });

  it("never launches limactl", () => {
    const sources = filesUnder(join(packageDir, "src")).filter(
      (path) => /\.(ts|mjs)$/.test(path) && !path.endsWith("no-vm.test.ts"),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) {
      expect({ path, limactl: /limactl/.test(readFileSync(path, "utf8")) }).toEqual({
        path,
        limactl: false,
      });
    }
  });
});
