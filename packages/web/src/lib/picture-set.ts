import { isAssetSrc, mediaKindOfSrc } from "./asset-links";
import { transformMarkdownUrl } from "./markdown-url";

export type PictureLayout = "grid" | "list";

export interface Picture {
  /** The address the picture loads from and the viewer opens, after the Markdown URL rules. */
  src: string;
  /** The alt text of the Markdown image. */
  title: string;
  /** The text after the image on its line. */
  note: string;
  /** The host of an outside picture, or null for one of this instance's own. */
  host: string | null;
}

export interface PictureSet {
  layout: PictureLayout;
  pictures: Picture[];
}

// One line: a Markdown image, then its note. This is the image grammar of the
// iOS parser (`MarkdownParser.imagePattern`), so both clients read a line alike.
const PICTURE_LINE = /^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)(.*)$/;

// The URL transform reads only the tag name of the element a URL belongs to.
const IMG_NODE = { tagName: "img" } as Parameters<typeof transformMarkdownUrl>[2];

/**
 * The layout a fence's info string asks for. `pictures list` is a list; a bare
 * `pictures`, or any other word after it, is a grid. `meta` is what follows the
 * language word, as Streamdown passes it on the code element.
 */
export function pictureLayout(meta: string | undefined): PictureLayout {
  return meta?.trim().split(/\s+/, 1)[0] === "list" ? "list" : "grid";
}

/**
 * `raw` after the rules a chat Markdown image goes through, or null when it
 * cannot be a picture. The shared URL transform runs first, so `/projects/...`
 * and `/memory/...` map to the asset routes. Then only https and this
 * instance's asset routes stay. `http:`, `data:`, `javascript:` and any other
 * relative path are dropped, and so is a video or audio file.
 */
function safePictureSrc(raw: string): { src: string; host: string | null } | null {
  const src = transformMarkdownUrl(raw, "src", IMG_NODE);
  if (!src || mediaKindOfSrc(src)) return null;
  if (isAssetSrc(src)) return { src, host: null };
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" || !url.hostname) return null;
    return { src, host: url.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/**
 * The lines of a fence's body. The renderer ends the body with a newline of
 * its own, which does not start a line.
 */
export function fenceBodyLines(body: string): string[] {
  const lines = body.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The pictures in the body of a ```pictures fence, one per line, or null when
 * no line yields a safe one (the fence then stays a code block). A line that is
 * not a Markdown image is skipped.
 *
 * While the fence is still open (`complete` false), the last line may be half
 * written, so it is left out until its newline arrives.
 */
export function parsePictureSet(
  body: string,
  { meta, complete = true }: { meta?: string; complete?: boolean } = {},
): PictureSet | null {
  const lines = fenceBodyLines(body);
  if (!complete) lines.pop();
  const pictures: Picture[] = [];
  for (const line of lines) {
    const match = PICTURE_LINE.exec(line);
    if (!match) continue;
    const safe = safePictureSrc(match[2] ?? "");
    if (!safe) continue;
    pictures.push({
      src: safe.src,
      host: safe.host,
      title: (match[1] ?? "").trim(),
      note: (match[3] ?? "").trim(),
    });
  }
  return pictures.length > 0 ? { layout: pictureLayout(meta), pictures } : null;
}
