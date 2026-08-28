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
import type { GenerateImageOutput } from "./types.js";

const config = { name: "generate_image" } as unknown as ActionConfig;

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
});
