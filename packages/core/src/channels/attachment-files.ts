import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Attachment, NormalizedMessage } from "./types.js";
import { getProfileMemoryDir } from "../paths.js";
import { createLogger } from "../logger.js";

export interface IncomingAttachmentPayload {
  attachment: Attachment;
  data: Buffer;
  fileName?: string;
  mimeType?: string;
}

const EXTENSIONS_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "application/pdf": ".pdf",
};

export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_SAFE_PATH_SEGMENT_BYTES = 180;
const MAX_SAFE_EXTENSION_BYTES = 24;

const log = createLogger("attachment-files");

export class AttachmentTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`attachment too large: ${bytes} bytes`);
    this.name = "AttachmentTooLargeError";
  }
}

const ALLOWED_ATTACHMENT_URLS: { hostname: string; pathnamePrefixes?: string[] }[] = [
  { hostname: "cdn.discordapp.com", pathnamePrefixes: ["/attachments/"] },
  { hostname: "media.discordapp.net", pathnamePrefixes: ["/attachments/"] },
  { hostname: "novac2c.cdn.weixin.qq.com", pathnamePrefixes: ["/c2c/"] },
  { hostname: "mmg.whatsapp.net" },
  { hostname: "api.telegram.org", pathnamePrefixes: ["/file/bot"] },
];

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;

  let result = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result.replace(/-+$/g, "");
}

export function safePathSegment(value: string): string {
  const normalized = value
    .replace(/[\0-\x1f<>:"/\\|?*\u007f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") return "unknown";
  return truncateUtf8(normalized, MAX_SAFE_PATH_SEGMENT_BYTES) || "unknown";
}

function safeExtension(value: string): string {
  if (!value || value === ".") return "";
  const cleaned = safePathSegment(value).replace(/^\.+/g, "");
  if (!cleaned || cleaned === "unknown") return "";
  return `.${truncateUtf8(cleaned, MAX_SAFE_EXTENSION_BYTES)}`;
}

function safeFileName(value: string): string {
  const stripped = basename(value).trim();
  const rawExtension = extname(stripped);
  const extension = safeExtension(rawExtension);
  const stem = rawExtension ? stripped.slice(0, -rawExtension.length) : stripped;
  const maxStemBytes = Math.max(1, MAX_SAFE_PATH_SEGMENT_BYTES - Buffer.byteLength(extension));
  return `${truncateUtf8(safePathSegment(stem), maxStemBytes)}${extension}`;
}

function extensionForAttachment(
  attachment: Attachment,
  mimeType?: string,
  fileName?: string,
): string {
  const existingExtension = extname(fileName ?? attachment.fileName ?? "");
  if (existingExtension) return existingExtension;
  const mimeExtension = mimeType ? EXTENSIONS_BY_MIME[mimeType.toLowerCase()] : undefined;
  if (mimeExtension) return mimeExtension;
  if (attachment.type === "image") return ".jpg";
  if (attachment.type === "video") return ".mp4";
  if (attachment.type === "audio") return ".mp3";
  return ".bin";
}

export function nameForAttachment(
  attachment: Attachment,
  index: number,
  mimeType?: string,
  fileName?: string,
): string {
  const candidate = fileName ?? attachment.fileName;
  if (candidate) {
    const sanitized = safeFileName(candidate);
    if (extname(sanitized)) return sanitized;
    return `${sanitized}${extensionForAttachment(attachment, mimeType, candidate)}`;
  }
  return `attachment-${index + 1}-${attachment.type}${extensionForAttachment(attachment, mimeType)}`;
}

function uniqueFileName(fileName: string, usedNames: Set<string>): string {
  let candidate = fileName;
  let next = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const extension = extname(fileName);
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    const suffix = `-${next}`;
    const maxStemBytes = Math.max(
      1,
      MAX_SAFE_PATH_SEGMENT_BYTES - Buffer.byteLength(extension) - Buffer.byteLength(suffix),
    );
    candidate = `${truncateUtf8(stem, maxStemBytes)}${suffix}${extension}`;
    next += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function contentLengthBytes(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function isAttachmentTooLargeError(err: unknown): err is AttachmentTooLargeError {
  return err instanceof AttachmentTooLargeError;
}

export async function readAttachmentByteStream(
  stream: AsyncIterable<Uint8Array>,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    if (!chunk) continue;

    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new AttachmentTooLargeError(total);
    }
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks, total);
}

export async function readAttachmentResponseBody(
  response: Response,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<Buffer> {
  const contentLength = contentLengthBytes(response.headers);
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new AttachmentTooLargeError(contentLength);
  }

  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new AttachmentTooLargeError(body.byteLength);
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AttachmentTooLargeError(total);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

export function isAllowedAttachmentUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const rule = ALLOWED_ATTACHMENT_URLS.find(
    (allowed) => url.hostname.toLowerCase() === allowed.hostname,
  );
  if (!rule) return false;

  if (!rule.pathnamePrefixes) return true;
  return rule.pathnamePrefixes.some((prefix) => url.pathname.startsWith(prefix));
}

/** The message whose files are saved: which channel, conversation and message
 *  carried them. A transport that emits `ChannelMessage` passes its
 *  `conversationId` as `threadId` and its `messageId` as `id`. */
export type IncomingAttachmentOwner = Pick<
  NormalizedMessage,
  "channel" | "threadId" | "id" | "attachments"
>;

export function getIncomingAttachmentDirectory(message: IncomingAttachmentOwner): string {
  return join(
    getProfileMemoryDir(),
    "channel-attachments",
    safePathSegment(message.channel),
    safePathSegment(message.threadId),
    safePathSegment(message.id),
  );
}

export async function saveIncomingAttachmentPayloads(
  message: IncomingAttachmentOwner,
  payloads: IncomingAttachmentPayload[],
): Promise<Attachment[]> {
  if (payloads.length === 0) return message.attachments;

  const directory = getIncomingAttachmentDirectory(message);
  await mkdir(directory, { recursive: true });

  const next = [...message.attachments];
  const usedNames = new Set<string>();
  for (const [index, payload] of payloads.entries()) {
    const attachmentIndex = message.attachments.indexOf(payload.attachment);
    if (attachmentIndex < 0) continue;

    const mimeType = payload.mimeType ?? payload.attachment.mimeType;
    const fileName = uniqueFileName(
      nameForAttachment(payload.attachment, index, mimeType, payload.fileName),
      usedNames,
    );
    const localPath = join(directory, fileName);
    await writeFile(localPath, payload.data);

    next[attachmentIndex] = {
      ...payload.attachment,
      mimeType,
      fileName,
      localPath,
    };
  }

  return next;
}

export async function saveUrlAttachments(message: NormalizedMessage): Promise<Attachment[]> {
  const payloads: IncomingAttachmentPayload[] = [];
  for (const attachment of message.attachments) {
    if (!attachment.url) continue;
    try {
      if (!isAllowedAttachmentUrl(attachment.url)) {
        throw new Error("blocked attachment URL host");
      }
      const response = await fetch(attachment.url, {
        signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`failed to download attachment: ${response.status}`);
      }
      payloads.push({
        attachment,
        data: await readAttachmentResponseBody(response),
        mimeType: response.headers.get("content-type") ?? attachment.mimeType,
        fileName: attachment.fileName,
      });
    } catch (err) {
      let host = "invalid";
      try {
        host = new URL(attachment.url).hostname;
      } catch {
        // Keep the logged URL summary non-sensitive and structured.
      }
      log.warn("failed to download attachment, continuing with remaining attachments", {
        host,
        type: attachment.type,
        fileName: attachment.fileName ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return saveIncomingAttachmentPayloads(message, payloads);
}
