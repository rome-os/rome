// @rstest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

const packageRoot = join(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const barrel = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");

describe("Command package boundary", () => {
  it("ships cmdk as an optional peer mirrored for local development", () => {
    expect(packageJson.peerDependencies?.cmdk).toBe("^1.1.1");
    expect(packageJson.peerDependenciesMeta?.cmdk).toEqual({ optional: true });
    expect(packageJson.devDependencies?.cmdk).toBe(packageJson.peerDependencies?.cmdk);
    expect(packageJson.dependencies?.cmdk).toBeUndefined();
  });

  it("keeps Command subpath-only so barrel consumers do not resolve cmdk", () => {
    expect(packageJson.exports?.["./command"]).toEqual({
      types: "./dist/command.d.ts",
      default: "./dist/command.js",
    });
    expect(barrel).not.toMatch(/(?:from|export\s+\*)\s+["']\.\/command\.js["']/);
  });
});
