import { basename } from "node:path";
import { storeAssetBytes } from "../assets/store.js";

export interface WebchatIncomingUpload {
  name: string;
  mimeType?: string;
  data: Buffer;
}

export interface SavedWebchatUpload {
  /** The sanitized name the guardian uploaded; it labels the link. */
  name: string;
  mimeType?: string;
  /** Where the copy lives on disk: `<profile>/assets/<id>.<ext>`. */
  path: string;
  /** The URL the dashboard serves it from: `/api/assets/<id>.<ext>`. */
  url: string;
  size: number;
}

function sanitizeUploadFileName(fileName: string): string {
  const stripped = basename(fileName).trim();
  const normalized = stripped.replace(/[\0-\x1f<>:"/\\|?*\u007f]+/g, "-").replace(/\s+/g, "-");
  const trimmed = normalized.replace(/^-+|-+$/g, "");

  if (!trimmed || trimmed === "." || trimmed === "..") {
    return "upload";
  }

  return trimmed;
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]]/g, "\\$&");
}

function encodeMarkdownDestination(path: string): string {
  return path
    .split("/")
    .map((segment, index) =>
      index === 0 && segment === ""
        ? ""
        : encodeURIComponent(segment).replace(
            /[!'()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
    )
    .join("/");
}

/**
 * Copy each upload into the asset store: a new random name every time, so two
 * pastes of `image.png` never meet. `maxBytes` caps one file (default
 * `MAX_ASSET_BYTES`); a larger one rejects with `AssetTooLargeError`.
 */
export async function saveWebchatUploads(
  uploads: WebchatIncomingUpload[],
  options: { maxBytes?: number } = {},
): Promise<SavedWebchatUpload[]> {
  const savedUploads: SavedWebchatUpload[] = [];
  for (const upload of uploads) {
    const name = sanitizeUploadFileName(upload.name);
    const stored = await storeAssetBytes(upload.data, name, options);
    savedUploads.push({
      name,
      mimeType: upload.mimeType,
      path: stored.path,
      url: stored.url,
      size: stored.size,
    });
  }

  return savedUploads;
}

/**
 * The turn text with one `- File N: [name](<url>)` line per upload. That text
 * is what gets persisted and shown. With `localPaths` (the model's copy of the
 * turn) each line also names the file on disk, so the agent can read it.
 */
export function appendUploadPathsToPrompt(
  text: string,
  uploads: Pick<SavedWebchatUpload, "name" | "url" | "path">[],
  options: { localPaths?: boolean } = {},
): string {
  if (uploads.length === 0) {
    return text.trim();
  }

  const promptText = text.trim();
  const lines = uploads.map(
    (upload, index) =>
      `- File ${index + 1}: [${escapeMarkdownLabel(upload.name)}](<${encodeMarkdownDestination(
        upload.url,
      )}>)${options.localPaths ? ` — local file: ${upload.path}` : ""}`,
  );

  return [promptText, lines.join("\n")].filter(Boolean).join("\n\n").trim();
}
