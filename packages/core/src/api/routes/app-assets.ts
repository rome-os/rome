import { readFile, stat } from "node:fs/promises";
import { Hono } from "hono";
import { isResolvedApp } from "../../apps/state.js";
import { resolvePathWithinBase } from "../../apps/packaging/index.js";
import type { ApiDeps } from "../deps.js";
import { contentTypeForPath } from "../../lib/content-types.js";

export function appAssetsRoutes(deps: Pick<ApiDeps, "appCatalog">): Hono {
  const app = new Hono();

  app.get("/app-assets/:appId/:version/*", async (c) => {
    const appId = c.req.param("appId");
    const version = c.req.param("version");
    const match = c.req.path.match(/\/app-assets\/[^/]+\/[^/]+\/(.*)$/);
    const assetSubPath = match?.[1] ?? "";
    if (!assetSubPath) {
      return c.text("Not found", 404);
    }

    try {
      const view = deps.appCatalog.get(appId);
      if (!isResolvedApp(view) || !view.web) {
        return c.text(`Unknown app "${appId}" or no frontend bundle`, 404);
      }

      if (view.web.assetVersion !== version) {
        return c.text("Not found", 404);
      }

      const assetPath = resolvePathWithinBase(
        view.web.distPath,
        assetSubPath,
        `asset for app "${appId}"`,
      );
      const fileStat = await stat(assetPath);
      if (!fileStat.isFile()) {
        return c.text("Not found", 404);
      }

      const content = await readFile(assetPath);
      return new Response(new Uint8Array(content), {
        status: 200,
        headers: {
          "Content-Type": contentTypeForPath(assetPath),
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("Unknown app") ? 404 : 400;
      return c.text(message, status);
    }
  });

  return app;
}
