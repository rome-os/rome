import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { nativeBuildHint } from "./native-build-hint.js";

// Verbatim pnpm 11.6.0 output. no-make and install-script-no-make come from the
// production image as rome, no-compiler from node:24-slim with only make added,
// and compile-error from node:24-bookworm, which has the full toolchain.
function fixture(name: string): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
  return readFileSync(join(dir, name), "utf-8");
}

describe("nativeBuildHint", () => {
  it("names the package node-gyp could not build without make", () => {
    expect(nativeBuildHint(fixture("pnpm-native-build-no-make.txt"))).toBe(
      "\nHint: building better-sqlite3 needs make and a C or C++ compiler, and Rome's image " +
        "ships neither. If better-sqlite3 bundles a prebuilt binary, declining its build " +
        'usually works: set `"better-sqlite3": false` under `allowBuilds` in the app\'s ' +
        "pnpm-workspace.yaml. The system:custom-dependencies skill covers the other options.",
    );
  });

  it("recognizes make running without a compiler", () => {
    expect(nativeBuildHint(fixture("pnpm-native-build-no-compiler.txt"))).toContain(
      'set `"bufferutil": false` under `allowBuilds`',
    );
  });

  it("recognizes an install script that calls make itself", () => {
    expect(nativeBuildHint(fixture("pnpm-install-script-no-make.txt"))).toContain(
      "Hint: building native-sh needs make",
    );
  });

  it("takes a scoped package name from the script's output prefix", () => {
    const output = ".../node_modules/@acme/addon install: sh: 1: g++: not found\n";
    expect(nativeBuildHint(output)).toContain('set `"@acme/addon": false`');
  });

  it("stays silent when the app's own script, not a dependency, lacks make", () => {
    expect(nativeBuildHint("> make\nsh: 1: make: not found\n[ELIFECYCLE] Command failed.\n")).toBe(
      "",
    );
  });

  it("stays silent on a compile error from a toolchain that is present", () => {
    expect(nativeBuildHint(fixture("pnpm-native-build-compile-error.txt"))).toBe("");
  });

  it("stays silent on a failure unrelated to native builds", () => {
    expect(nativeBuildHint(fixture("pnpm-fetch-404.txt"))).toBe("");
  });
});
