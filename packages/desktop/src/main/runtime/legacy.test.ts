import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { legacyRuntimeDir } from "./legacy";

describe("legacyRuntimeDir", () => {
  const homes: string[] = [];
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "rome-legacy-"));
    homes.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is null on a computer that never ran the private VM", () => {
    expect(legacyRuntimeDir(home())).toBeNull();
  });

  it("names the folder the private VM left behind", () => {
    const dir = home();
    mkdirSync(join(dir, ".rome-desktop", "runtime", "rome-home"), { recursive: true });
    expect(legacyRuntimeDir(dir)).toBe(join(dir, ".rome-desktop", "runtime"));
  });
});
