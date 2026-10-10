import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { createAppLogger, defineAction, getCurrentActionContext, z } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  GeneratedImage,
  ImageGenerationInterface,
  ImageGenerationProviderInfo,
} from "@rome-os/app-runtime";
import type {
  GenerateImageBatchItem,
  GenerateImageBatchOutput,
  GenerateImageOutput,
} from "./types.js";
export type {
  GenerateImageBatchItem,
  GenerateImageBatchOutput,
  GenerateImageOutput,
} from "./types.js";

const log = createAppLogger("generate-image");

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_INPUT_IMAGES = 6;
const MAX_BATCH_PROMPTS = 20;
/** Images in flight at once during a batch, each in its own provider session. */
const BATCH_CONCURRENCY = 5;

export const generateImageInputSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The image prompt — describe the desired image (subject, style, composition, colors). " +
          "It is forwarded verbatim to the image model. Provide either prompt or prompts.",
      ),
    prompts: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BATCH_PROMPTS)
      .optional()
      .describe(
        `Batch mode: up to ${MAX_BATCH_PROMPTS} prompts, one image each. Images generate ` +
          `${BATCH_CONCURRENCY} at a time, each in its own image model session, so prompts never ` +
          "see each other. Returns one result per prompt, in order, and succeeds when at least " +
          "one image is produced. Provide either prompt or prompts.",
      ),
    input_image_paths: z
      .array(z.string().min(1))
      .max(MAX_INPUT_IMAGES)
      .optional()
      .describe(
        `Optional: absolute local paths of up to ${MAX_INPUT_IMAGES} input images for the model to ` +
          "edit or combine (e.g. a previously generated imagePath, or a saved attachment path). " +
          "The prompt should say what to do with them. In batch mode every prompt receives " +
          "the same input images.",
      ),
  })
  .refine((input) => (input.prompt === undefined) !== (input.prompts === undefined), {
    message: "Provide exactly one of prompt or prompts.",
  });

export type GenerateImageInput = z.infer<typeof generateImageInputSchema>;

export interface GenerateImageDeps {
  imageGeneration: ImageGenerationInterface;
}

function readEnvPath(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return undefined;
  return trimmed;
}

function getProfileDir(): string {
  return join(homedir(), ".rome", process.env.ROME_PROFILE || "default");
}

// Must stay in lockstep with send_message's attachment-root resolution so a
// generated image is always a valid attachment source.
function getProjectsRoot(): string {
  return (
    readEnvPath("ROME_PROJECTS_ROOT") ??
    readEnvPath("ROME_WEBCHAT_PROJECTS_ROOT") ??
    join(getProfileDir(), "projects")
  );
}

function describeUnavailable(
  providers: Array<ImageGenerationProviderInfo & { reason: string; remedy: string }>,
): string {
  if (providers.length === 0) {
    return "Image generation is not available: no image generation provider is configured.";
  }
  const detail = providers.map((p) => `${p.displayName}: ${p.reason}. ${p.remedy}`).join(" ");
  return `Image generation requires a connected image provider, but none is available right now. ${detail}`;
}

async function persistImage(
  image: GeneratedImage,
): Promise<{ imagePath: string; fileName: string; mimeType: string; bytes: number }> {
  const directory = join(getProjectsRoot(), ".rome", "generated-images");
  await mkdir(directory, { recursive: true });

  if (image.data) {
    const mimeType = image.mimeType ?? "image/png";
    const extension = EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? ".png";
    const fileName = `image-${randomUUID()}${extension}`;
    const imagePath = join(directory, fileName);
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.byteLength === 0) {
      throw new Error("image generation returned empty image data");
    }
    await writeFile(imagePath, bytes);
    return { imagePath, fileName, mimeType, bytes: bytes.byteLength };
  }

  if (!image.sourcePath) {
    throw new Error("image generation result carried neither image data nor a source path");
  }
  const extension = extname(image.sourcePath).toLowerCase() || ".png";
  const fileName = `image-${randomUUID()}${extension}`;
  const imagePath = join(directory, fileName);
  await copyFile(image.sourcePath, imagePath);
  const file = await stat(imagePath);
  return {
    imagePath,
    fileName,
    mimeType: image.mimeType ?? MIME_BY_EXTENSION[extension] ?? "image/png",
    bytes: file.size,
  };
}

function assetUrl(fileName: string, bytes: number): string {
  const logicalPath = ["projects", ".rome", "generated-images", fileName].join("/");
  return (
    `/api/projects/asset/${encodeURIComponent(fileName)}` +
    `?path=${encodeURIComponent(logicalPath)}&v=${Date.now()}-${bytes}`
  );
}

type GenerateOneResult =
  | { status: "ok"; data: GenerateImageOutput }
  | { status: "unavailable" | "failed"; error: string };

async function validateInputImages(paths: string[]): Promise<string | undefined> {
  // Fail fast with a per-path message; the provider re-validates content
  // (byte sniffing, size caps) and also fails rather than dropping inputs.
  for (const path of paths) {
    if (!isAbsolute(path)) return `input image path must be absolute: ${path}`;
    try {
      const file = await stat(path);
      if (!file.isFile()) return `input image is not a file: ${path}`;
    } catch {
      return `input image not found: ${path}`;
    }
  }
  return undefined;
}

async function generateOne(
  deps: GenerateImageDeps,
  prompt: string,
  inputImagePaths: string[],
  sharedContext: Record<string, unknown> | undefined,
): Promise<GenerateOneResult> {
  const outcome = await deps.imageGeneration.generate(
    { prompt, ...(inputImagePaths.length ? { inputImagePaths } : {}) },
    { sharedContext },
  );

  if (outcome.status === "unavailable") {
    return { status: "unavailable", error: describeUnavailable(outcome.providers) };
  }
  if (outcome.status === "failed") {
    return { status: "failed", error: outcome.message };
  }

  try {
    const saved = await persistImage(outcome.image);
    log.info("generated image saved", {
      provider: outcome.providerId,
      fileName: saved.fileName,
      mimeType: saved.mimeType,
      bytes: saved.bytes,
    });
    return {
      status: "ok",
      data: {
        imagePath: saved.imagePath,
        imageUrl: assetUrl(saved.fileName, saved.bytes),
        mimeType: saved.mimeType,
        provider: outcome.providerId,
        ...(outcome.image.revisedPrompt ? { revisedPrompt: outcome.image.revisedPrompt } : {}),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("failed to persist generated image", { error: message });
    return { status: "failed", error: `Failed to save the generated image: ${message}` };
  }
}

async function generateBatch(
  prompts: string[],
  generate: (prompt: string) => Promise<GenerateOneResult>,
): Promise<ActionResult<GenerateImageBatchOutput>> {
  const results: Array<GenerateImageBatchItem | undefined> = new Array(prompts.length);
  let next = 0;
  let unavailable: string | undefined;

  // A sliding window rather than lock-step groups of five: a slot frees as
  // soon as its image finishes, so one slow image never idles the other four.
  // Each worker claims `next` synchronously before awaiting, so no two
  // workers take the same prompt. An unavailable provider stays unavailable
  // for the rest of the batch, so workers stop claiming prompts once one
  // reports it, and the unclaimed prompts are reported as not attempted.
  const worker = async (): Promise<void> => {
    while (next < prompts.length && unavailable === undefined) {
      const index = next++;
      const prompt = prompts[index];
      let result: GenerateOneResult;
      try {
        result = await generate(prompt);
      } catch (err) {
        result = { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      if (result.status === "unavailable") unavailable ??= result.error;
      results[index] =
        result.status === "ok"
          ? { index, prompt, status: "ok", ...result.data }
          : { index, prompt, status: "error", error: result.error };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, prompts.length) }, () => worker()),
  );

  const settled = prompts.map(
    (prompt, index): GenerateImageBatchItem =>
      results[index] ?? {
        index,
        prompt,
        status: "error",
        error: "Not attempted: image generation became unavailable earlier in the batch.",
      },
  );
  const succeeded = settled.filter((item) => item.status === "ok").length;
  const failed = settled.length - succeeded;
  log.info("generated image batch", { total: settled.length, succeeded, failed });

  if (succeeded === 0) {
    if (unavailable !== undefined) return { status: "error", error: unavailable };
    const reasons = new Set(
      settled.flatMap((item) => (item.status === "error" ? [item.error] : [])),
    );
    return {
      status: "error",
      error: `All ${settled.length} images failed. ${[...reasons].join(" | ")}`,
    };
  }
  return { status: "ok", data: { results: settled, succeeded, failed } };
}

/**
 * Creates the generate_image action: hands each prompt to the image generation
 * capability (which picks a connected provider — Codex today), then saves the
 * returned image under the projects root so both channels (send_message
 * attachments) and the dashboard (asset URL) can serve it.
 *
 * `prompt` returns a single GenerateImageOutput. `prompts` returns a
 * GenerateImageBatchOutput with one entry per prompt in input order, and
 * errors only when no image was produced.
 */
export function createGenerateImageAction(config: ActionConfig, deps: GenerateImageDeps): Action {
  return defineAction({
    config,
    schema: generateImageInputSchema,
    execute: async ({
      prompt,
      prompts,
      input_image_paths,
    }): Promise<ActionResult<GenerateImageOutput | GenerateImageBatchOutput>> => {
      const inputImagePaths = input_image_paths ?? [];
      const invalidInput = await validateInputImages(inputImagePaths);
      if (invalidInput) return { status: "error", error: invalidInput };

      const sharedContext = getCurrentActionContext()?.sharedContext;
      const generate = (text: string) => generateOne(deps, text, inputImagePaths, sharedContext);

      if (prompts) return generateBatch(prompts, generate);

      // The schema guarantees exactly one of prompt / prompts.
      const result = await generate(prompt as string);
      return result.status === "ok"
        ? { status: "ok", data: result.data }
        : { status: "error", error: result.error };
    },
    preview: ({ prompt, prompts }) => ({
      kind: "generic",
      title: prompts ? `Generate ${prompts.length} images` : "Generate an image",
      summary: prompts ? prompts.join("\n") : (prompt ?? ""),
    }),
  });
}

export function createAction(config: ActionConfig, deps: GenerateImageDeps): Action {
  return createGenerateImageAction(config, deps);
}
