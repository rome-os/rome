import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { buildTurnInput, MAX_INPUT_IMAGE_BYTES } from "./turn-input.js";

// Minimal valid PNG: the 8-byte signature is all `sniffImageMimeType` needs.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
// Minimal JPEG signature.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rome-codex-turn-input-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("buildTurnInput", () => {
  it("returns a single text item when no images are attached", async () => {
    await expect(buildTurnInput("hello", [])).resolves.toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });

  it("inlines each attached image as a data-URL item with its sniffed mime type", async () => {
    const dir = await makeTempDir();
    const png = join(dir, "a.png");
    const jpeg = join(dir, "b.bin"); // extension is irrelevant — bytes decide
    await writeFile(png, PNG_BYTES);
    await writeFile(jpeg, JPEG_BYTES);

    const items = await buildTurnInput("combine", [png, jpeg]);

    expect(items).toEqual([
      { type: "text", text: "combine", text_elements: [] },
      { type: "image", url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` },
      { type: "image", url: `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}` },
    ]);
  });

  it("throws when an image path is unreadable instead of dropping it", async () => {
    const dir = await makeTempDir();
    await expect(buildTurnInput("x", [join(dir, "missing.png")])).rejects.toThrow(/not readable/);
  });

  it("throws when the bytes are not a supported raster image", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "not-an-image.png");
    await writeFile(path, "just text");
    await expect(buildTurnInput("x", [path])).rejects.toThrow(/not a supported raster image/);
  });

  it("throws on empty and oversized images", async () => {
    const dir = await makeTempDir();
    const empty = join(dir, "empty.png");
    await writeFile(empty, Buffer.alloc(0));
    await expect(buildTurnInput("x", [empty])).rejects.toThrow(/empty/);

    const oversized = join(dir, "big.png");
    const big = Buffer.alloc(MAX_INPUT_IMAGE_BYTES + 1);
    PNG_BYTES.copy(big);
    await writeFile(oversized, big);
    await expect(buildTurnInput("x", [oversized])).rejects.toThrow(/exceeds/);
  });
});
