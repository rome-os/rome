import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./storage.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { force: true, recursive: true });
});

describe("private credential storage", () => {
  it("restricts access and atomically replaces persisted credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rome-node-credentials-"));
    directories.push(dir);
    const path = join(dir, "private", "credential.json");
    expect(await readPrivateJson(path)).toBeNull();
    await writePrivateJson(path, { token: "first" });
    await writePrivateJson(path, { token: "replacement" });
    expect(await readPrivateJson(path)).toEqual({ token: "replacement" });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "private"))).mode & 0o777).toBe(0o700);
    }
    await writeFile(path, "malformed json");
    expect(await readPrivateJson(path)).toBeNull();
  });
});
