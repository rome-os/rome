import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ActionConfig,
  ImageGenerationInterface,
  ImageGenerationOutcome,
} from "@rome-os/app-runtime";
import { createGenerateImageAction } from "./index.js";
import type { GenerateImageBatchOutput, GenerateImageOutput } from "./types.js";

const config = { name: "generate_image" } as unknown as ActionConfig;

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const OK_IMAGE: ImageGenerationOutcome = {
  status: "ok",
  providerId: "codex",
  image: { data: PNG_BASE64, mimeType: "image/png" },
};

/** A capability whose generate() resolves per prompt and records peak concurrency. */
function makeBatchCapability(outcomeFor: (prompt: string) => ImageGenerationOutcome) {
  let inFlight = 0;
  const stats = { peak: 0 };
  const generate = rs.fn(async (request: { prompt: string }) => {
    inFlight += 1;
    stats.peak = Math.max(stats.peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return outcomeFor(request.prompt);
  });
  const capability = {
    listProviders: () => [{ id: "codex", displayName: "Codex (ChatGPT)" }],
    generate,
  } as unknown as ImageGenerationInterface & { generate: typeof generate };
  return { capability, stats };
}

function makeCapability(
  outcome: ImageGenerationOutcome,
): ImageGenerationInterface & { generate: ReturnType<typeof rs.fn> } {
  return {
    listProviders: () => [{ id: "codex", displayName: "Codex (ChatGPT)" }],
    generate: rs.fn(async () => outcome),
  };
}

let projectsRoot: string;

beforeEach(async () => {
  projectsRoot = await mkdtemp(join(tmpdir(), "generate-image-test-"));
  rs.stubEnv("ROME_PROJECTS_ROOT", projectsRoot);
});

afterEach(async () => {
  rs.unstubAllEnvs();
  await rm(projectsRoot, { recursive: true, force: true });
});

describe("generate_image", () => {
  it("hands the prompt to the capability and saves the inline image", async () => {
    const capability = makeCapability({
      status: "ok",
      providerId: "codex",
      image: { data: PNG_BASE64, mimeType: "image/png", revisedPrompt: "a refined red fox" },
    });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const result = await action.execute({ prompt: "a red fox in the snow" });

    expect(capability.generate).toHaveBeenCalledTimes(1);
    expect(capability.generate.mock.calls[0][0]).toEqual({ prompt: "a red fox in the snow" });

    expect(result.status).toBe("ok");
    const data = (result as { status: "ok"; data: GenerateImageOutput }).data;
    expect(data.imagePath).toContain(join(projectsRoot, ".rome", "generated-images"));
    expect(data.imagePath).toMatch(/\.png$/);
    expect(data.mimeType).toBe("image/png");
    expect(data.provider).toBe("codex");
    expect(data.revisedPrompt).toBe("a refined red fox");
    expect(data.imageUrl).toContain("/api/projects/asset/");
    expect(data.imageUrl).toContain(encodeURIComponent("projects/.rome/generated-images/"));
    const saved = await readFile(data.imagePath);
    expect(saved.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
  });

  it("copies the image from sourcePath when no inline data is present", async () => {
    const sourcePath = join(projectsRoot, "provider-original.webp");
    await writeFile(sourcePath, Buffer.from("webp-bytes"));
    const capability = makeCapability({
      status: "ok",
      providerId: "codex",
      image: { sourcePath },
    });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const result = await action.execute({ prompt: "anything" });

    expect(result.status).toBe("ok");
    const data = (result as { status: "ok"; data: GenerateImageOutput }).data;
    expect(data.imagePath).toMatch(/\.webp$/);
    expect(data.mimeType).toBe("image/webp");
    expect((await readFile(data.imagePath)).toString()).toBe("webp-bytes");
  });

  it("forwards validated input images to the capability", async () => {
    const first = join(projectsRoot, "first.png");
    const second = join(projectsRoot, "second.png");
    await writeFile(first, Buffer.from(PNG_BASE64, "base64"));
    await writeFile(second, Buffer.from(PNG_BASE64, "base64"));
    const capability = makeCapability({
      status: "ok",
      providerId: "codex",
      image: { data: PNG_BASE64, mimeType: "image/png" },
    });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const result = await action.execute({
      prompt: "combine these",
      input_image_paths: [first, second],
    });

    expect(result.status).toBe("ok");
    expect(capability.generate.mock.calls[0][0]).toEqual({
      prompt: "combine these",
      inputImagePaths: [first, second],
    });
  });

  it("rejects missing and non-absolute input image paths before calling the capability", async () => {
    const capability = makeCapability({
      status: "ok",
      providerId: "codex",
      image: { data: PNG_BASE64 },
    });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const missing = await action.execute({
      prompt: "x",
      input_image_paths: [join(projectsRoot, "does-not-exist.png")],
    });
    expect(missing.status).toBe("error");
    expect((missing as { error: string }).error).toContain("not found");

    const relative = await action.execute({
      prompt: "x",
      input_image_paths: ["relative/photo.png"],
    });
    expect(relative.status).toBe("error");
    expect((relative as { error: string }).error).toContain("must be absolute");

    expect(capability.generate).not.toHaveBeenCalled();
  });

  it("turns an unavailable outcome into per-provider connect guidance", async () => {
    const capability = makeCapability({
      status: "unavailable",
      providers: [
        {
          id: "codex",
          displayName: "Codex (ChatGPT)",
          reason: "the Codex (ChatGPT) account is not connected",
          remedy: "Connect Codex under AI tools, then retry.",
        },
      ],
    });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const result = await action.execute({ prompt: "anything" });

    expect(result.status).toBe("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("Codex (ChatGPT)");
    expect(error).toContain("Connect Codex");
  });

  it("reports a configuration gap when no provider is registered at all", async () => {
    const capability = makeCapability({ status: "unavailable", providers: [] });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const result = await action.execute({ prompt: "anything" });

    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("no image generation provider");
  });

  it("passes a failed outcome's message through", async () => {
    const capability = makeCapability({
      status: "failed",
      providerId: "codex",
      message: "The model did not produce an image. I cannot generate images.",
    });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const result = await action.execute({ prompt: "anything" });

    expect(result).toEqual({
      status: "error",
      error: "The model did not produce an image. I cannot generate images.",
    });
  });

  it("reports a save failure when the image payload is unusable", async () => {
    const capability = makeCapability({
      status: "ok",
      providerId: "codex",
      image: { data: "" },
    });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const result = await action.execute({ prompt: "anything" });

    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("Failed to save the generated image");
  });

  it("rejects input without a prompt", async () => {
    const capability = makeCapability({
      status: "ok",
      providerId: "codex",
      image: { data: PNG_BASE64 },
    });
    const action = createGenerateImageAction(config, { imageGeneration: capability });

    const result = await action.execute({});

    expect(result.status).toBe("error");
    expect(capability.generate).not.toHaveBeenCalled();
  });

  describe("batch mode", () => {
    it("generates one image per prompt, five at a time, in input order", async () => {
      const prompts = Array.from({ length: 7 }, (_, i) => `prompt ${i}`);
      const { capability, stats } = makeBatchCapability(() => OK_IMAGE);
      const action = createGenerateImageAction(config, { imageGeneration: capability });

      const result = await action.execute({ prompts });

      expect(result.status).toBe("ok");
      const data = (result as { status: "ok"; data: GenerateImageBatchOutput }).data;
      expect(data.succeeded).toBe(7);
      expect(data.failed).toBe(0);
      expect(data.results.map((item) => item.prompt)).toEqual(prompts);
      expect(data.results.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(capability.generate).toHaveBeenCalledTimes(7);
      expect(stats.peak).toBe(5);
      const paths = data.results.map((item) => (item.status === "ok" ? item.imagePath : ""));
      expect(new Set(paths).size).toBe(7);
      for (const path of paths) {
        expect((await readFile(path)).equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
      }
    });

    it("reports per-prompt failures and succeeds when any image is produced", async () => {
      const { capability } = makeBatchCapability((prompt) =>
        prompt === "bad"
          ? { status: "failed", providerId: "codex", message: "content policy" }
          : OK_IMAGE,
      );
      const action = createGenerateImageAction(config, { imageGeneration: capability });

      const result = await action.execute({ prompts: ["good", "bad", "also good"] });

      expect(result.status).toBe("ok");
      const data = (result as { status: "ok"; data: GenerateImageBatchOutput }).data;
      expect(data.succeeded).toBe(2);
      expect(data.failed).toBe(1);
      expect(data.results[1]).toEqual({
        index: 1,
        prompt: "bad",
        status: "error",
        error: "content policy",
      });
      expect(data.results[0].status).toBe("ok");
      expect(data.results[2].status).toBe("ok");
    });

    it("stops claiming prompts once the provider is unavailable", async () => {
      const { capability } = makeBatchCapability(() => ({
        status: "unavailable",
        providers: [
          {
            id: "codex",
            displayName: "Codex (ChatGPT)",
            reason: "the Codex (ChatGPT) account is not connected",
            remedy: "Connect Codex under AI tools, then retry.",
          },
        ],
      }));
      const action = createGenerateImageAction(config, { imageGeneration: capability });

      const result = await action.execute({
        prompts: Array.from({ length: 12 }, (_, i) => `prompt ${i}`),
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("Connect Codex");
      expect(capability.generate.mock.calls.length).toBeLessThanOrEqual(5);
    });

    it("errors with every distinct reason when no image is produced", async () => {
      const { capability } = makeBatchCapability((prompt) => ({
        status: "failed",
        providerId: "codex",
        message: `refused ${prompt}`,
      }));
      const action = createGenerateImageAction(config, { imageGeneration: capability });

      const result = await action.execute({ prompts: ["a", "b"] });

      expect(result.status).toBe("error");
      const error = (result as { error: string }).error;
      expect(error).toContain("All 2 images failed");
      expect(error).toContain("refused a");
      expect(error).toContain("refused b");
    });

    it("keeps a thrown generation contained to its own prompt", async () => {
      const { capability } = makeBatchCapability((prompt) => {
        if (prompt === "boom") throw new Error("rpc dropped");
        return OK_IMAGE;
      });
      const action = createGenerateImageAction(config, { imageGeneration: capability });

      const result = await action.execute({ prompts: ["boom", "fine"] });

      expect(result.status).toBe("ok");
      const data = (result as { status: "ok"; data: GenerateImageBatchOutput }).data;
      expect(data.results[0]).toMatchObject({ status: "error", error: "rpc dropped" });
      expect(data.results[1].status).toBe("ok");
    });

    it("forwards the shared input images with every prompt", async () => {
      const reference = join(projectsRoot, "reference.png");
      await writeFile(reference, Buffer.from(PNG_BASE64, "base64"));
      const { capability } = makeBatchCapability(() => OK_IMAGE);
      const action = createGenerateImageAction(config, { imageGeneration: capability });

      await action.execute({ prompts: ["one", "two"], input_image_paths: [reference] });

      for (const [request] of capability.generate.mock.calls) {
        expect(request).toMatchObject({ inputImagePaths: [reference] });
      }
    });

    it("rejects both prompt and prompts, and oversized batches", async () => {
      const { capability } = makeBatchCapability(() => OK_IMAGE);
      const action = createGenerateImageAction(config, { imageGeneration: capability });

      const both = await action.execute({ prompt: "x", prompts: ["y"] });
      expect(both.status).toBe("error");
      expect((both as { error: string }).error).toContain("exactly one of prompt or prompts");

      const oversized = await action.execute({
        prompts: Array.from({ length: 21 }, (_, i) => `p${i}`),
      });
      expect(oversized.status).toBe("error");

      const empty = await action.execute({ prompts: [] });
      expect(empty.status).toBe("error");

      expect(capability.generate).not.toHaveBeenCalled();
    });
  });
});
