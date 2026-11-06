import { promises as fs } from "node:fs";
import type { UserInput } from "./app-server-protocol.js";
import { sniffImageMimeType } from "./image-trace.js";

/** Input images ride the JSON-RPC turn request inline as data URLs — keep them bounded. */
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Builds the `turn/start` input items: the turn text plus one image item per
 * attached local image, inlined as a data URL (self-contained — no dependence
 * on what the app-server process can read from disk). An unreadable, empty,
 * oversized, or non-image attachment throws instead of being dropped: a turn
 * that asked to edit N images must never silently run with fewer.
 */
export async function buildTurnInput(text: string, imagePaths: string[]): Promise<UserInput[]> {
  const items: UserInput[] = [{ type: "text", text, text_elements: [] }];
  for (const path of imagePaths) {
    items.push({ type: "image", url: await readImageAsDataUrl(path) });
  }
  return items;
}

async function readImageAsDataUrl(path: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`input image is not readable: ${path} (${detail})`);
  }
  if (bytes.byteLength === 0) {
    throw new Error(`input image is empty: ${path}`);
  }
  if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(
      `input image exceeds ${Math.floor(MAX_INPUT_IMAGE_BYTES / (1024 * 1024))}MB: ${path}`,
    );
  }
  const mimeType = sniffImageMimeType(bytes);
  if (!mimeType) {
    throw new Error(
      `input image is not a supported raster image (png/jpeg/gif/webp/avif): ${path}`,
    );
  }
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}
