import { getInternalRawPath, isInternalHref } from "./internal-href";

export type AssetKind = "image" | "video" | "audio" | "pdf" | "file";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "ogg"]);

/** What a file shows as in chat, by its extension. */
export function assetKind(extension: string): AssetKind {
  const ext = extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return ext === "pdf" ? "pdf" : "file";
}

/** The kind of media a `src` plays as, ignoring its query, or null for anything else. */
export function mediaKindOfSrc(src: string): "video" | "audio" | null {
  const path = src.split(/[?#]/)[0] ?? "";
  const extension = /\.([a-z0-9]{1,8})$/i.exec(path)?.[1];
  const kind = extension ? assetKind(extension) : "file";
  return kind === "video" || kind === "audio" ? kind : null;
}

const ASSET_PATH = /^\/api\/assets\/[0-9a-f]{32}\.([a-z0-9]{1,8})$/;

/**
 * A link to a file in the asset store (`/api/assets/<id>.<ext>`, relative or
 * on this origin), as its path and kind; null for any other href.
 */
export function parseAssetHref(href: string | undefined): { path: string; kind: AssetKind } | null {
  if (!isInternalHref(href)) return null;
  const raw = getInternalRawPath(href);
  if (raw === null) return null;
  const path = raw.split(/[?#]/)[0] ?? "";
  const match = ASSET_PATH.exec(path);
  return match ? { path: raw, kind: assetKind(match[1] ?? "") } : null;
}

export interface UploadLink {
  /** The name the guardian uploaded; it labels the file. */
  label: string;
  /** `/api/assets/<id>.<ext>` */
  url: string;
  kind: AssetKind;
}

const UPLOAD_LINE = /^- File \d+: \[(.*)\]\(<(\/api\/assets\/[0-9a-f]{32}\.([a-z0-9]{1,8}))>\)$/;

/**
 * Splits the lines the server appends for uploaded files, `- File 1:
 * [image.png](</api/assets/<id>.png>)`, off the end of a message. Only that
 * list counts: it sits at the very end, after a blank line (or nothing), and
 * every line of it links the asset store. Older messages that link under
 * `/projects/` stay text.
 */
export function splitUploadLines(text: string): { text: string; uploads: UploadLink[] } {
  const lines = text.split("\n");
  const uploads: UploadLink[] = [];
  while (lines.length > 0) {
    const match = UPLOAD_LINE.exec(lines.at(-1) ?? "");
    if (!match) break;
    uploads.unshift({
      label: (match[1] ?? "").replace(/\\(.)/g, "$1"),
      url: match[2] ?? "",
      kind: assetKind(match[3] ?? ""),
    });
    lines.pop();
  }
  if (uploads.length === 0) return { text, uploads: [] };
  const before = lines.at(-1);
  if (before !== undefined && before.trim() !== "") return { text, uploads: [] };
  return { text: lines.join("\n").trim(), uploads };
}
