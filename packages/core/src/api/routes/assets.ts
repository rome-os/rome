import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import {
  ASSET_IMAGE_WIDTHS,
  RESIZABLE_IMAGE_TYPES,
  createStreamResponse,
  describeFile,
  parseRangeHeader,
  resizeAssetImage,
} from "../../lib/file-browser-server.js";
import { getAssetsDir } from "../../paths.js";

const ASSET_NAME = /^([0-9a-f]{32})\.([a-z0-9]{1,8})$/;

// Only these open in the browser. The route is same-origin with the dashboard,
// so html, xml, js and anything unknown must download instead of running.
const INLINE_EXTENSIONS = new Set([
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"],
  ...["mp4", "webm", "mov", "mp3", "m4a", "wav", "ogg", "pdf"],
]);

const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

/**
 * `GET /api/assets/:name`: the files in the asset store (`assets/store.ts`).
 * It sits under `/api`, so the forward-auth cookie gate applies. Each file is
 * immutable, so responses are cached for a year.
 */
export function assetsRoutes(): Hono {
  const app = new Hono();

  app.get("/assets/:name", async (c) => {
    const notFound = () => c.json({ error: "Not found" }, 404);
    const match = ASSET_NAME.exec(c.req.param("name"));
    if (!match) return notFound();
    const [name, id, extension] = match;

    const path = join(getAssetsDir(), name);
    let size: number;
    try {
      // lstat: a symlink planted in the store is never followed.
      const info = await lstat(path);
      if (!info.isFile()) return notFound();
      size = info.size;
    } catch {
      return notFound();
    }

    const file = describeFile(name);
    const inline = INLINE_EXTENSIONS.has(extension);
    const requestedWidth = c.req.query("w");
    const width =
      requestedWidth !== undefined &&
      ASSET_IMAGE_WIDTHS.has(requestedWidth) &&
      RESIZABLE_IMAGE_TYPES.has(file.mimeType)
        ? Number(requestedWidth)
        : undefined;
    const etag = `"${width ? `${id}-w${width}` : id}"`;
    const headers: Record<string, string> = {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy": extension === "pdf" ? CSP : `${CSP}; sandbox`,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    };

    const validators = (c.req.header("If-None-Match") ?? "").split(",").map((tag) => tag.trim());
    if (validators.some((tag) => tag === "*" || tag.replace(/^W\//, "") === etag)) {
      return new Response(null, { headers, status: 304 });
    }

    // A download carries no filename, so the name the page asks for (the chip's
    // `download` attribute) decides what the file is saved as.
    const disposition = (fileName: string) =>
      inline ? `inline; filename="${fileName}"` : "attachment";
    const baseHeaders: Record<string, string> = {
      ...headers,
      "Accept-Ranges": "bytes",
      "Content-Disposition": disposition(name),
      "Content-Length": String(size),
      "Content-Type": file.mimeType,
    };

    if (width) {
      const resized = await resizeAssetImage(path, width);
      if (resized && resized.length < size) {
        return new Response(new Uint8Array(resized), {
          headers: {
            ...baseHeaders,
            "Content-Disposition": disposition(`${id}.webp`),
            "Content-Length": String(resized.length),
            "Content-Type": "image/webp",
          },
          status: 200,
        });
      }
    }

    const rangeHeader = c.req.header("range");
    if (rangeHeader && inline && ["video", "audio", "pdf"].includes(file.kind)) {
      const range = parseRangeHeader(rangeHeader, size);
      if (!range) {
        return new Response(null, {
          headers: {
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            "Content-Range": `bytes */${size}`,
          },
          status: 416,
        });
      }
      return createStreamResponse(
        path,
        206,
        {
          ...baseHeaders,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        },
        range.start,
        range.end,
      );
    }

    return createStreamResponse(path, 200, baseHeaders);
  });

  return app;
}
