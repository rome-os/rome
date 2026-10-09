import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { AgentEvent } from "../../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("codex-image-trace");

const MAX_TRACE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_CODEX_ROLLOUT_BYTES = 32 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Map<string, string>([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export interface ImageTraceSessionState {
  /** Generated image files already represented in trace blocks. Codex's
   * built-in `image_gen` sometimes writes files without an SDK stream event,
   * so the provider also watches the generated-images directory. */
  emittedGeneratedImagePaths: Set<string>;
}

export interface ToolTraceState {
  /** Tool ids we already emitted a tool_use for; protects against duplicates
   * if codex emits both item.started and item.updated before item.completed. */
  emittedToolUseIds: Set<string>;
}

interface GeneratedImageFile {
  path: string;
  mtimeMs: number;
}

interface GeneratedImagePromptMetadata {
  prompt?: string;
  revisedPrompt?: string;
}

export interface GeneratedImageTracker {
  collectTraceMessages(ctx: ToolTraceState & ImageTraceSessionState): Promise<AgentEvent[]>;
}

export function createImageTraceSessionState(): ImageTraceSessionState {
  return {
    emittedGeneratedImagePaths: new Set(),
  };
}

export interface GeneratedImageTrackerOptions {
  /**
   * Codex saves generated images under `generated_images/<threadId>/`. When
   * the session's thread id is known, the scan is scoped to that directory so
   * concurrent sessions never observe (and mis-attribute) each other's images.
   * Undefined (no thread opened yet) falls back to the whole tree.
   */
  getThreadId?: () => string | undefined;
}

export async function createGeneratedImageTracker(
  options: GeneratedImageTrackerOptions = {},
): Promise<GeneratedImageTracker> {
  const root = getCodexGeneratedImagesDir();
  if (!root) {
    return { collectTraceMessages: async () => [] };
  }

  const seen = new Set((await listGeneratedImageFiles(root)).map((file) => file.path));
  return {
    collectTraceMessages: async (ctx) => {
      const threadId = options.getThreadId?.();
      const files = await listGeneratedImageFiles(threadId ? join(root, threadId) : root);
      const messages: AgentEvent[] = [];
      for (const file of files) {
        if (seen.has(file.path) || ctx.emittedGeneratedImagePaths.has(file.path)) continue;
        seen.add(file.path);
        ctx.emittedGeneratedImagePaths.add(file.path);
        messages.push(...(await generatedImageFileTraceMessages(file)));
      }
      return messages;
    },
  };
}

/** An image-generation item or event that codex reports as failed. */
function imageGenerationFailed(value: Record<string, unknown>): boolean {
  return value.status === "failed" || (typeof value.error === "string" && value.error.length > 0);
}

export function translateImageGenerationStarted(
  item: { id?: unknown; [k: string]: unknown },
  ctx: ToolTraceState,
): AgentEvent[] {
  const id =
    (typeof item.id === "string" ? item.id : readCodexItemId(item)) ?? syntheticImageGenerationId();
  if (ctx.emittedToolUseIds.has(id)) return [];
  ctx.emittedToolUseIds.add(id);
  return [
    {
      type: "tool_use",
      id,
      tool: "ImageGeneration",
      input: imageGenerationInputPayload(item),
      startedAt: new Date().toISOString(),
    },
  ];
}

export async function translateImageGenerationCompleted(
  item: { id?: unknown; [k: string]: unknown },
  ctx: ToolTraceState & ImageTraceSessionState,
): Promise<AgentEvent[]> {
  const imageGenerationId = item.id ?? syntheticImageGenerationId();
  const imageGenerationOutput = await imageGenerationOutputPayload(item);
  rememberGeneratedImagePath(ctx, item);
  return [
    ...maybeBackfillStarted(
      { ...item, id: String(imageGenerationId) },
      ctx,
      "ImageGeneration",
      imageGenerationInputPayload(item),
    ),
    {
      type: "tool_result",
      toolUseId: String(imageGenerationId),
      tool: "ImageGeneration",
      output: imageGenerationOutput,
      endedAt: new Date().toISOString(),
      isError: imageGenerationFailed(item),
    },
  ];
}

async function listGeneratedImageFiles(root: string): Promise<GeneratedImageFile[]> {
  try {
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const path = resolve(root, entry.parentPath, entry.name);
          if (!IMAGE_MIME_TYPES.has(extname(path).toLowerCase())) return undefined;
          try {
            const stat = await fs.stat(path);
            if (!stat.isFile() || stat.size > MAX_TRACE_IMAGE_BYTES) return undefined;
            return { path, mtimeMs: stat.mtimeMs };
          } catch {
            return undefined;
          }
        }),
    );
    return files
      .filter((file): file is GeneratedImageFile => file !== undefined)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return [];
  }
}

async function generatedImageFileTraceMessages(file: GeneratedImageFile): Promise<AgentEvent[]> {
  const id = syntheticImageGenerationId();
  const timestamp = new Date(file.mtimeMs).toISOString();
  const metadata = await readGeneratedImagePromptMetadata(file.path);
  const input: Record<string, unknown> = { source: "codex_generated_images" };
  if (metadata.prompt) input.prompt = metadata.prompt;
  if (metadata.revisedPrompt) input.revised_prompt = metadata.revisedPrompt;
  const outputRecord: Record<string, unknown> = {
    status: "completed",
    saved_path: file.path,
    // Filesystem-backstop results are inferred, not correlated to a specific
    // image-generation call in the stream. The marker lets consumers (e.g.
    // the generate_image capability provider) prefer directly-correlated
    // results when both arrive.
    source: "codex_generated_images",
  };
  if (metadata.revisedPrompt) outputRecord.revised_prompt = metadata.revisedPrompt;
  return [
    {
      type: "tool_use",
      id,
      tool: "ImageGeneration",
      input,
      startedAt: timestamp,
    },
    {
      type: "tool_result",
      toolUseId: id,
      tool: "ImageGeneration",
      output: await imageGenerationOutputPayload(outputRecord),
      endedAt: timestamp,
      isError: false,
    },
  ];
}

async function readGeneratedImagePromptMetadata(
  imagePath: string,
): Promise<GeneratedImagePromptMetadata> {
  const codexHome = getCodexHomeDir();
  if (!codexHome) return {};
  const generatedImageDirId = basename(dirname(imagePath));
  if (!generatedImageDirId) return {};

  const rolloutPath = await findCodexRolloutPath(codexHome, generatedImageDirId);
  if (!rolloutPath) return {};
  return readImageGenerationPromptMetadataFromRollout(rolloutPath, imagePath);
}

async function findCodexRolloutPath(
  codexHome: string,
  generatedImageDirId: string,
): Promise<string | undefined> {
  const sessionsDir = join(codexHome, "sessions");
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  await collectMatchingRolloutPaths(sessionsDir, generatedImageDirId, matches);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path;
}

async function collectMatchingRolloutPaths(
  dir: string,
  generatedImageDirId: string,
  matches: Array<{ path: string; mtimeMs: number }>,
): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fs.readdir(dir, { encoding: "utf8", withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectMatchingRolloutPaths(path, generatedImageDirId, matches);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      if (!entry.name.startsWith("rollout-") || !entry.name.includes(generatedImageDirId)) return;
      try {
        const stat = await fs.stat(path);
        if (!stat.isFile() || stat.size > MAX_CODEX_ROLLOUT_BYTES) return;
        matches.push({ path, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore files that disappear while scanning
      }
    }),
  );
}

async function readImageGenerationPromptMetadataFromRollout(
  rolloutPath: string,
  imagePath: string,
): Promise<GeneratedImagePromptMetadata> {
  const callId = generatedImageCallId(imagePath);
  const metadata: GeneratedImagePromptMetadata = {};
  try {
    const contents = await fs.readFile(rolloutPath, "utf8");
    for (const line of contents.split("\n")) {
      const payload = readRolloutPayload(line);
      if (!payload || !isImageGenerationRolloutPayload(payload)) continue;
      const savedPath =
        readStringField(payload, "saved_path") ?? readStringField(payload, "savedPath");
      const payloadCallId = readCodexItemId(payload);
      if (savedPath !== imagePath && (!callId || payloadCallId !== callId)) continue;

      const prompt = readStringField(payload, "prompt");
      const revisedPrompt = readStringField(payload, "revised_prompt");
      if (prompt) metadata.prompt = prompt;
      if (revisedPrompt) metadata.revisedPrompt = revisedPrompt;
    }
  } catch (err) {
    log.warn("failed to read codex rollout for generated image prompt", {
      rolloutPath,
      imagePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return metadata;
}

function readRolloutPayload(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { payload?: unknown };
    return parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
      ? (parsed.payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isImageGenerationRolloutPayload(payload: Record<string, unknown>): boolean {
  return payload.type === "image_generation_end" || payload.type === "image_generation_call";
}

function generatedImageCallId(imagePath: string): string | undefined {
  const name = basename(imagePath);
  const extension = extname(name);
  const callId = extension ? name.slice(0, -extension.length) : name;
  return callId.startsWith("ig_") ? callId : undefined;
}

function syntheticImageGenerationId(): string {
  return `image-generation-${randomUUID()}`;
}

function rememberGeneratedImagePath(
  ctx: ImageTraceSessionState,
  record: Record<string, unknown>,
): void {
  const savedPath = readStringField(record, "saved_path") ?? readStringField(record, "savedPath");
  if (savedPath) ctx.emittedGeneratedImagePaths.add(resolve(savedPath));
}

function readCodexItemId(record: Record<string, unknown>): string | undefined {
  for (const key of ["id", "item_id", "itemId", "call_id", "callId"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function imageGenerationInputPayload(record: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of ["prompt", "output_format", "size", "quality", "model"]) {
    const value = record[key];
    if (value !== undefined) payload[key] = value;
  }
  if (Object.keys(payload).length > 0) return payload;
  const args = record.arguments;
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

async function imageGenerationOutputPayload(
  record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const savedPath = readStringField(record, "saved_path") ?? readStringField(record, "savedPath");
  const savedPathMimeType = savedPath
    ? IMAGE_MIME_TYPES.get(extname(savedPath).toLowerCase())
    : undefined;
  const resultMimeType = readImageResultMimeType(record);
  const payload: Record<string, unknown> = {
    type: "image",
  };

  for (const key of ["status", "revised_prompt", "saved_path", "savedPath", "error", "source"]) {
    const value = record[key];
    if (value !== undefined) payload[key] = value;
  }

  const resultImage = readInlineImageResult(record.result, resultMimeType);
  if (resultImage) {
    payload.data = resultImage.data;
    payload.mimeType = resultImage.mimeType;
  } else if (record.result !== undefined) {
    payload.result = record.result;
  }

  if (!payload.data && savedPath) {
    const image = await readGeneratedImageData(savedPath, savedPathMimeType);
    if (image) {
      payload.data = image.data;
      payload.mimeType = image.mimeType;
    }
  }

  return payload;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readGeneratedImageData(
  path: string,
  expectedMimeType?: string,
): Promise<{ data: string; mimeType: string } | undefined> {
  try {
    const realPath = await fs.realpath(resolve(path));
    const allowedDirs = await traceImageReadRoots();
    if (!allowedDirs.some((dir) => isPathInside(realPath, dir))) return undefined;
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || stat.size > MAX_TRACE_IMAGE_BYTES) return undefined;
    const bytes = await fs.readFile(realPath);
    return imageDataFromBytes(bytes, expectedMimeType);
  } catch (err) {
    log.warn("failed to read generated image for trace", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function traceImageReadRoots(): Promise<string[]> {
  const candidates = [tmpdir(), getCodexGeneratedImagesDir()].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  const roots = await Promise.all(
    candidates.map(async (dir) => {
      try {
        return await fs.realpath(dir);
      } catch {
        return undefined;
      }
    }),
  );
  return roots.filter((dir): dir is string => dir !== undefined);
}

function getCodexGeneratedImagesDir(): string | undefined {
  const codexHome = getCodexHomeDir();
  return codexHome ? join(codexHome, "generated_images") : undefined;
}

function getCodexHomeDir(): string | undefined {
  return (
    process.env.CODEX_HOME ?? (process.env.HOME ? join(process.env.HOME, ".codex") : undefined)
  );
}

function isPathInside(path: string, dir: string): boolean {
  const normalizedDir = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return path.startsWith(normalizedDir);
}

function readImageResultMimeType(record: Record<string, unknown>): string {
  const explicit = readStringField(record, "mimeType") ?? readStringField(record, "mime_type");
  if (explicit?.startsWith("image/")) return explicit;
  const outputFormat =
    readStringField(record, "output_format") ?? readStringField(record, "format");
  switch (outputFormat?.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}

function readInlineImageResult(
  result: unknown,
  expectedMimeType: string,
): { data: string; mimeType: string } | undefined {
  if (typeof result !== "string" || result.length === 0) return undefined;
  const dataUrl = result.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (dataUrl) {
    return imageDataFromBase64(dataUrl[2], dataUrl[1]);
  }
  return imageDataFromBase64(result, expectedMimeType);
}

function imageDataFromBase64(
  value: string,
  expectedMimeType?: string,
): { data: string; mimeType: string } | undefined {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length === 0 || normalized.length % 4 === 1) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return undefined;
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.length > MAX_TRACE_IMAGE_BYTES) return undefined;
  if (bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    return undefined;
  }
  return imageDataFromBytes(bytes, expectedMimeType);
}

function imageDataFromBytes(
  bytes: Buffer,
  expectedMimeType?: string,
): { data: string; mimeType: string } | undefined {
  const sniffedMimeType = sniffImageMimeType(bytes);
  if (!sniffedMimeType) return undefined;
  if (
    expectedMimeType &&
    expectedMimeType !== sniffedMimeType &&
    !(expectedMimeType === "image/apng" && sniffedMimeType === "image/png")
  ) {
    return undefined;
  }
  return {
    data: bytes.toString("base64"),
    mimeType: expectedMimeType ?? sniffedMimeType,
  };
}

export function sniffImageMimeType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const ascii = bytes.toString("ascii", 0, Math.min(bytes.length, 16));
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 12 && ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return undefined;
}

function maybeBackfillStarted(
  item: { id: string; [k: string]: unknown },
  ctx: ToolTraceState,
  tool: string,
  input: unknown,
): AgentEvent[] {
  if (ctx.emittedToolUseIds.has(item.id)) return [];
  ctx.emittedToolUseIds.add(item.id);
  return [
    {
      type: "tool_use",
      id: item.id,
      tool,
      input,
      startedAt: new Date().toISOString(),
    },
  ];
}
