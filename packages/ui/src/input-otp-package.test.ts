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

describe("InputOTP package boundary", () => {
  it("ships input-otp as an optional peer mirrored for local development", () => {
    expect(packageJson.peerDependencies?.["input-otp"]).toBe("^1.4.2");
    expect(packageJson.peerDependenciesMeta?.["input-otp"]).toEqual({ optional: true });
    expect(packageJson.devDependencies?.["input-otp"]).toBe(
      packageJson.peerDependencies?.["input-otp"],
    );
    expect(packageJson.dependencies?.["input-otp"]).toBeUndefined();
  });

  it("keeps InputOTP subpath-only so barrel consumers do not resolve input-otp", () => {
    expect(packageJson.exports?.["./input-otp"]).toEqual({
      types: "./dist/input-otp.d.ts",
      default: "./dist/input-otp.js",
    });
    expect(barrel).not.toMatch(/(?:from|export\s+\*)\s+["']\.\/input-otp\.js["']/);
  });
});
