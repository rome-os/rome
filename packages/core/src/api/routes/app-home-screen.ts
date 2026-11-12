import { Hono } from "hono";
import { renderHomeScreenIcon } from "../../apps/og/home-screen-icon.js";
import { buildAppWebManifest } from "../app-home-screen.js";
import { isResolvedWebApp } from "../app-social-card.js";
import type { ApiDeps } from "../deps.js";
import { decodeAppIdPathSegment, InvalidAppApiPathError } from "../helpers.js";

const MANIFEST_PATH_RE = /^\/app-manifest\/([^/]+)\.webmanifest$/;
const ICON_PATH_RE = /^\/app-icon\/([^/]+)\.png$/;

function decodeSegment(path: string, re: RegExp): string | null {
  const match = path.match(re);
  if (!match) return null;
  try {
    return decodeAppIdPathSegment(match[1]);
  } catch (err) {
    if (err instanceof InvalidAppApiPathError) return null;
    throw err;
  }
}

/**
 * Per-app web manifest and home-screen icon, linked from app documents (see
 * api/app-home-screen.ts). Public like /app-og: a phone fetches both without
 * the session cookie. Paths are matched by hand because Hono's `:name` labels
 * cannot carry a literal suffix. The icon is rendered per request — it is
 * fetched only when someone adds or installs the app — and cached by the
 * browser under its `?v=<updatedAt>` URL.
 */
export function appHomeScreenRoutes(deps: Pick<ApiDeps, "appCatalog">): Hono {
  const app = new Hono();

  app.get("/app-manifest/*", (c) => {
    const appId = decodeSegment(c.req.path, MANIFEST_PATH_RE);
    const view = appId === null ? null : deps.appCatalog.get(appId);
    if (appId === null || !isResolvedWebApp(view)) return c.text("Not found", 404);
    return c.body(JSON.stringify(buildAppWebManifest(appId, view)), 200, {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-cache",
    });
  });

  app.get("/app-icon/*", async (c) => {
    const appId = decodeSegment(c.req.path, ICON_PATH_RE);
    const view = appId === null ? null : deps.appCatalog.get(appId);
    if (!isResolvedWebApp(view)) return c.text("Not found", 404);
    const png = await renderHomeScreenIcon(view);
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
