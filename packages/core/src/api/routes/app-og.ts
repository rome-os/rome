import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";
import { decodeAppIdPathSegment, InvalidAppApiPathError } from "../helpers.js";

const PATH_RE = /^\/app-og\/([^/]+)\.png$/;

/**
 * Social card image for an installed app; the catalog is consulted so
 * orphaned files are never served. Public like /app-assets (auth's
 * verify probe 204s every non-/api path). `/app-og/<seg>.png` is matched by
 * hand: Hono's `:name` labels cannot carry a literal `.png` suffix.
 */
export function appOgRoutes(deps: Pick<ApiDeps, "ogImageStore" | "appCatalog">): Hono {
  const app = new Hono();

  app.get("/app-og/*", async (c) => {
    const match = c.req.path.match(PATH_RE);
    if (!match) return c.text("Not found", 404);
    let appId: string;
    try {
      appId = decodeAppIdPathSegment(match[1]);
    } catch (err) {
      if (err instanceof InvalidAppApiPathError) return c.text("Not found", 404);
      throw err;
    }
    // The catalog is the source of truth: a card left behind by an interrupted
    // uninstall, or one for an app that is no longer installed, is not served.
    if (deps.appCatalog.get(appId) === null) return c.text("Not found", 404);
    const png = await deps.ogImageStore.read(appId);
    if (png === null) return c.text("Not found", 404);
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  return app;
}
