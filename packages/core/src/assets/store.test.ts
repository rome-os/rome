import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAssetsDir } from "../paths.js";
import { AssetTooLargeError, MAX_ASSET_BYTES, assetExtension, storeAssetBytes } from "./store.js";

describe("asset store", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rome-asset-store-"));
    rs.stubEnv("HOME", home);
    rs.stubEnv("ROME_PROFILE", "asset-store-test");
  });

  afterEach(() => {
    rs.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps the assets under the profile directory", () => {
    expect(getAssetsDir()).toBe(join(home, ".rome", "asset-store-test", "assets"));
  });

  it("stores bytes under a 32-hex id with the URL, size and read-only mode", async () => {
    const stored = await storeAssetBytes(Buffer.from("hello"), "image.png");

    expect(stored.id).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.fileName).toBe(`${stored.id}.png`);
    expect(stored.url).toBe(`/api/assets/${stored.id}.png`);
    expect(stored.path).toBe(join(getAssetsDir(), stored.fileName));
    expect(stored.size).toBe(5);
    expect(readFileSync(stored.path, "utf-8")).toBe("hello");
    expect(statSync(stored.path).mode & 0o777).toBe(0o444);
  });

  it("gives two files with the same name different ids and paths", async () => {
    const first = await storeAssetBytes(Buffer.from("one"), "image.png");
    const second = await storeAssetBytes(Buffer.from("two"), "image.png");

    expect(second.id).not.toBe(first.id);
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path, "utf-8")).toBe("one");
    expect(readFileSync(second.path, "utf-8")).toBe("two");
  });

  it("leaves no temporary file behind, so only the final name is ever visible", async () => {
    const stored = await storeAssetBytes(Buffer.from("x"), "a.txt");

    expect(readdirSync(getAssetsDir()).sort()).toEqual([".tmp", stored.fileName].sort());
    expect(readdirSync(join(getAssetsDir(), ".tmp"))).toEqual([]);
  });

  it("retries with a new id instead of overwriting an existing asset", async () => {
    const taken = "a".repeat(32);
    mkdirSync(getAssetsDir(), { recursive: true });
    const first = await storeAssetBytes(Buffer.from("original"), "x.png", {
      generateId: () => taken,
    });
    const ids = [taken, taken, "b".repeat(32)];
    const second = await storeAssetBytes(Buffer.from("newer"), "x.png", {
      generateId: () => ids.shift() ?? "c".repeat(32),
    });

    expect(first.id).toBe(taken);
    expect(second.id).toBe("b".repeat(32));
    expect(readFileSync(first.path, "utf-8")).toBe("original");
    expect(readFileSync(second.path, "utf-8")).toBe("newer");
    expect(readdirSync(join(getAssetsDir(), ".tmp"))).toEqual([]);
  });

  it("gives up after a bounded number of name clashes", async () => {
    await storeAssetBytes(Buffer.from("a"), "x.png", { generateId: () => "d".repeat(32) });
    await expect(
      storeAssetBytes(Buffer.from("b"), "x.png", { generateId: () => "d".repeat(32) }),
    ).rejects.toThrow("Could not allocate an asset name");
  });

  it.each([
    ["image.PNG", "png"],
    ["archive.tar.GZ", "gz"],
    ["noext", "bin"],
    ["weird.ext!", "bin"],
    ["long.abcdefghi", "bin"],
    ["dot.", "bin"],
    [".hidden", "bin"],
    ["日本.写真", "bin"],
  ])("normalises the extension of %s to %s", async (name, extension) => {
    expect(assetExtension(name)).toBe(extension);
    expect((await storeAssetBytes(Buffer.from("x"), name)).fileName).toMatch(
      new RegExp(`^[0-9a-f]{32}\\.${extension}$`),
    );
  });

  it("refuses a file over the cap", async () => {
    expect(MAX_ASSET_BYTES).toBe(100 * 1024 * 1024);
    await expect(
      storeAssetBytes(Buffer.alloc(11), "big.bin", { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
    await expect(
      storeAssetBytes(Buffer.alloc(10), "ok.bin", { maxBytes: 10 }),
    ).resolves.toBeTruthy();
  });
});
