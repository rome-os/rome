import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const GEMINI_VIDEO_URL = "https://gemini.google.com/videos";
export const GEMINI_VIDEO_DEFAULT_OUTPUT = "~/tmp/gemini-videos";
export const GEMINI_VIDEO_RATIOS = ["16:9", "9:16"];
export const GEMINI_VIDEO_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"];
export const GEMINI_VIDEO_MAX_IMAGES = 10;

const RATIO_MENU_LABELS = {
  "16:9": "Landscape (16:9)",
  "9:16": "Portrait (9:16)",
};

/** Menu entry Gemini shows for an aspect ratio in the video composer. */
export function geminiVideoRatioLabel(ratio) {
  const label = RATIO_MENU_LABELS[String(ratio ?? "").trim()];
  if (!label) throw new Error(`ratio must be one of: ${GEMINI_VIDEO_RATIOS.join(", ")}`);
  return label;
}

export function integerInRange(value, name, min, max) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return num;
}

export function expandHomePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

export function resolveGeminiVideoOutputDir(value) {
  const expanded = expandHomePath(value);
  return expanded || expandHomePath(GEMINI_VIDEO_DEFAULT_OUTPUT);
}

/**
 * `--image` carries a comma-separated list because OpenCLI options are single
 * valued. Paths are resolved against the working directory and must exist, so a
 * typo fails before the browser session is touched.
 */
export function parseGeminiVideoImages(value, { exists = fs.existsSync } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const files = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => expandHomePath(item));
  if (files.length > GEMINI_VIDEO_MAX_IMAGES) {
    throw new Error(`image accepts at most ${GEMINI_VIDEO_MAX_IMAGES} files`);
  }
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!GEMINI_VIDEO_IMAGE_EXTENSIONS.includes(ext)) {
      throw new Error(`image ${file} must be one of: ${GEMINI_VIDEO_IMAGE_EXTENSIONS.join(", ")}`);
    }
    if (!exists(file)) throw new Error(`image not found: ${file}`);
  }
  return files;
}

const SAFE_NAME = /[^a-z0-9._-]+/gi;

/** File name for the saved clip: explicit `--name` wins, else a timestamp. */
export function buildGeminiVideoFileName(name, stamp = Date.now()) {
  const raw = String(name ?? "").trim();
  if (!raw) return `gemini_video_${stamp}.mp4`;
  const cleaned = raw.replace(SAFE_NAME, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) return `gemini_video_${stamp}.mp4`;
  return cleaned.toLowerCase().endsWith(".mp4") ? cleaned : `${cleaned}.mp4`;
}

const ERROR_PATTERNS = [
  /couldn['’]t (?:generate|create)/i,
  /can['’]t (?:generate|create)/i,
  /unable to (?:generate|create)/i,
  /daily limit/i,
  /reached your limit/i,
  /limit for (?:today|video)/i,
  /not available/i,
  /something went wrong/i,
  /wasn['’]t able to/i,
  /violat/i,
];

const GENERATING_PATTERNS = [/generating your video/i, /could take a few minutes/i];

/** The part of the page that describes the current turn, without the sidebar. */
export function geminiVideoStatusText(snapshot) {
  const text = String(snapshot?.responseText ?? snapshot?.bodyTail ?? "");
  return text.replace(/\s+/g, " ").trim();
}

/** Pick the generated clip: the first `<video>` with a fetchable http(s) source. */
export function pickGeminiVideoSource(videos) {
  if (!Array.isArray(videos)) return null;
  for (const video of videos) {
    const src = String(video?.src ?? "").trim();
    if (/^https?:\/\//i.test(src)) {
      const duration = Number(video?.duration);
      return {
        src,
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      };
    }
  }
  return null;
}

/**
 * Reduce a page snapshot to one of `ready`, `error`, `generating`, or `pending`.
 * A rendered video wins over any wording because Gemini keeps the earlier
 * progress copy on screen while the player mounts.
 */
export function classifyGeminiVideoState(snapshot) {
  const source = pickGeminiVideoSource(snapshot?.videos);
  if (source) return { status: "ready", source };
  const text = geminiVideoStatusText(snapshot);
  for (const pattern of ERROR_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const start = Math.max(0, match.index - 80);
      return {
        status: "error",
        message: text.slice(start, match.index + 160).trim(),
      };
    }
  }
  if (GENERATING_PATTERNS.some((pattern) => pattern.test(text))) {
    return { status: "generating" };
  }
  return { status: "pending" };
}

function cookieDomainMatches(cookieDomain, hostname) {
  const domain = String(cookieDomain ?? "")
    .replace(/^\./, "")
    .toLowerCase();
  if (!domain) return false;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Gemini serves clips from a usercontent host that redirects anonymous
 * requests to a sign-in page, so the download needs the session cookies the
 * browser would send. Only cookies whose domain covers the host are forwarded.
 */
export function buildGeminiVideoCookieHeader(cookies, url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  const parts = [];
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") continue;
    if (!cookieDomainMatches(cookie.domain, hostname)) continue;
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.join("; ");
}

export function isVideoContentType(value) {
  const type = String(value ?? "").toLowerCase();
  return type.startsWith("video/") || type.includes("octet-stream");
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return `${seconds.toFixed(1)}s`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function displayPath(filePath) {
  const home = os.homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

export function summarizeGeminiVideoResult({ status, file, bytes, duration, link, images }) {
  return {
    status,
    file: file ? displayPath(file) : "-",
    size: bytes ? formatBytes(bytes) : "",
    duration: formatDuration(duration),
    images: Array.isArray(images) ? images.length : 0,
    link: link || "",
  };
}
