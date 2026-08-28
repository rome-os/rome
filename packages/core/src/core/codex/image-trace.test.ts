import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  createGeneratedImageTracker,
  createImageTraceSessionState,
  translateImageGenerationCompleted,
  type ImageTraceSessionState,
  type ToolTraceState,
} from "./image-trace.js";
import type { AgentMessage } from "../../types.js";

// Minimal valid PNG: the 8-byte signature is all `sniffImageMimeType` needs.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function newCtx(): ToolTraceState & ImageTraceSessionState {
  return { emittedToolUseIds: new Set(), ...createImageTraceSessionState() };
}

function toolResult(
  msgs: AgentMessage[],
): (AgentMessage & { output?: Record<string, unknown> }) | undefined {
  return msgs.find((m) => m.type === "tool_result") as
    | (AgentMessage & { output?: Record<string, unknown> })
    | undefined;
}

const tempDirs: string[] = [];
async function makeTempDir(prefix: string, root = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(root, prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("translateImageGenerationCompleted", () => {
  it("inlines an image data URL carried on the item's `result`", async () => {
    const item = {
      type: "imageGeneration",
      id: "img-inline",
      status: "completed",
      result: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
    };
    const msgs = await translateImageGenerationCompleted(item, newCtx());

    expect(msgs.some((m) => m.type === "tool_use" && m.tool === "ImageGeneration")).toBe(true);
    expect(toolResult(msgs)?.output).toMatchObject({
      type: "image",
      data: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
      status: "completed",
    });
  });

  it("reads the on-disk image when `savedPath` points inside an allowed dir", async () => {
    const dir = await makeTempDir("rome-codex-image-trace-");
    const imagePath = join(dir, "apple.png");
    await writeFile(imagePath, PNG_BYTES);

    const item = {
      type: "imageGeneration",
      id: "img-disk",
      status: "completed",
      // Non-base64 sentinel forces the saved-path disk fallback.
      result: "generated",
      savedPath: imagePath,
    };
    const msgs = await translateImageGenerationCompleted(item, newCtx());

    expect(toolResult(msgs)?.output).toMatchObject({
      type: "image",
      data: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
      savedPath: imagePath,
      status: "completed",
    });
  });

  it("does not inline a saved path whose content is not a supported raster image", async () => {
    const dir = await makeTempDir("rome-codex-image-trace-");
    const imagePath = join(dir, "not-actually-an-image.png");
    await writeFile(imagePath, "not an image");

    const item = {
      type: "imageGeneration",
      id: "img-invalid",
      status: "completed",
      savedPath: imagePath,
    };
    const out = toolResult(await translateImageGenerationCompleted(item, newCtx()))?.output;

    expect(out).toMatchObject({ type: "image", savedPath: imagePath, status: "completed" });
    expect(out).not.toHaveProperty("data");
    expect(out).not.toHaveProperty("mimeType");
  });

  it("does not inline a saved path outside the allowed read roots", async () => {
    // Under the repo cwd — neither the OS temp dir nor ~/.codex/generated_images.
    const dir = await makeTempDir(".rome-codex-image-trace-", process.cwd());
    const imagePath = join(dir, "outside.png");
    await writeFile(imagePath, PNG_BYTES);

    const item = {
      type: "imageGeneration",
      id: "img-outside",
      status: "completed",
      savedPath: imagePath,
    };
    const out = toolResult(await translateImageGenerationCompleted(item, newCtx()))?.output;

    expect(out).toMatchObject({ type: "image", savedPath: imagePath, status: "completed" });
    expect(out).not.toHaveProperty("data");
  });
});

describe("createGeneratedImageTracker", () => {
  it("emits trace blocks for image files that appear after the tracker is created, once each", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = await makeTempDir("rome-codex-home-");
    process.env.CODEX_HOME = codexHome;
    try {
      // Snapshot taken now: ~/.codex/generated_images is still empty.
      const tracker = await createGeneratedImageTracker();

      const imageDir = join(codexHome, "generated_images", "run-1");
      await mkdir(imageDir, { recursive: true });
      const imagePath = join(imageDir, "ig_generated.png");
      await writeFile(imagePath, PNG_BYTES);

      const ctx = newCtx();
      const first = await tracker.collectTraceMessages(ctx);
      expect(first.some((m) => m.type === "tool_use" && m.tool === "ImageGeneration")).toBe(true);
      expect(toolResult(first)?.output).toMatchObject({
        type: "image",
        data: PNG_BYTES.toString("base64"),
        mimeType: "image/png",
        // Backstop results self-identify so consumers can prefer results
        // correlated to an actual image-generation call.
        source: "codex_generated_images",
      });

      // Already emitted → not surfaced again on the next drain.
      const second = await tracker.collectTraceMessages(ctx);
      expect(second).toEqual([]);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("scopes concurrent sessions to their own thread dir so they never swap images", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = await makeTempDir("rome-codex-home-");
    process.env.CODEX_HOME = codexHome;
    try {
      // Two overlapping sessions, each scoped to its own Codex thread. Both
      // snapshot before either image lands, so without scoping each would
      // observe (and emit) the other's file.
      const trackerA = await createGeneratedImageTracker({ getThreadId: () => "thread-a" });
      const trackerB = await createGeneratedImageTracker({ getThreadId: () => "thread-b" });

      const dirA = join(codexHome, "generated_images", "thread-a");
      const dirB = join(codexHome, "generated_images", "thread-b");
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });
      const pathA = join(dirA, "ig_a.png");
      const pathB = join(dirB, "ig_b.png");
      await writeFile(pathA, PNG_BYTES);
      await writeFile(pathB, PNG_BYTES);

      const fromA = await trackerA.collectTraceMessages(newCtx());
      const fromB = await trackerB.collectTraceMessages(newCtx());

      expect(toolResult(fromA)?.output).toMatchObject({ saved_path: pathA });
      expect(fromA.filter((m) => m.type === "tool_result")).toHaveLength(1);
      expect(toolResult(fromB)?.output).toMatchObject({ saved_path: pathB });
      expect(fromB.filter((m) => m.type === "tool_result")).toHaveLength(1);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});
