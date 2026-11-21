/**
 * A Discord attachment as Rome describes it, one way for a message heard live
 * and one read back from history, so both name the same file the same way.
 */

import { extname } from "node:path";
import type { Attachment } from "../../../types.js";

/**
 * The human-readable attachment name as the uploader saw it. Discord sanitizes
 * filenames that contain non-ASCII characters (e.g. "腾讯会议录制转写文件.txt"
 * becomes "580f8fdeeb994c86.txt") and preserves the original — minus extension —
 * in the `title` field. Reconstruct the display name from `title` + the cleaned
 * extension; fall back to `filename` when no title is present.
 */
function discordAttachmentName(filename: string, title?: string | null): string {
  if (!title) return filename;
  const ext = extname(filename);
  return ext && !title.toLowerCase().endsWith(ext.toLowerCase()) ? `${title}${ext}` : title;
}

/** One Discord attachment, as discord.js and Discord's REST API both carry
 *  its fields. */
export interface DiscordAttachmentFields {
  url: string;
  name?: string | null;
  title?: string | null;
  contentType?: string | null;
}

/** The attachment Rome describes for a Discord one. An image names no type. */
export function discordAttachment(att: DiscordAttachmentFields): Attachment {
  const mimeType = att.contentType ?? undefined;
  const fileName = att.name ? discordAttachmentName(att.name, att.title) : (att.title ?? undefined);
  if (mimeType?.startsWith("image/")) return { type: "image", url: att.url, fileName };
  if (mimeType?.startsWith("video/")) return { type: "video", url: att.url, mimeType, fileName };
  if (mimeType?.startsWith("audio/")) return { type: "audio", url: att.url, mimeType, fileName };
  return { type: "document", url: att.url, mimeType, fileName };
}
