import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createLogger } from "../../logger.js";
import { appIdToPathSegment } from "../packaging/app-id.js";
import type { CatalogEvent, ResolvedApp, SubscriberHandler } from "../state.js";
import { svgToPng } from "./rasterize.js";
import type { OgImageStore } from "./store.js";
import { firstSentence, type OgIcon, renderOgSvg } from "./template.js";

const log = createLogger("app-og-image");

const ICON_MIMES: Record<string, OgIcon["mime"]> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function readIcon(app: ResolvedApp): Promise<OgIcon | null> {
  const iconPath = app.iconAbsolutePath;
  if (!iconPath) return null;
  const mime = ICON_MIMES[extname(iconPath).toLowerCase()];
  if (!mime) return null; // webp etc. → default mark
  try {
    return { mime, bytes: await readFile(iconPath) };
  } catch {
    return null;
  }
}

/** Card description: the author's tagline, or a mechanical fallback. */
export function cardDescription(manifest: { tagline?: string; description: string }): string {
  return manifest.tagline ?? firstSentence(manifest.description);
}

/** Template + rasterizer for one app. */
async function generateOgImage(app: ResolvedApp, link: string | null): Promise<Buffer> {
  const svg = renderOgSvg({
    name: app.displayName,
    description: cardDescription(app.manifest),
    link,
    icon: await readIcon(app),
  });
  return svgToPng(svg);
}

export interface AppOgImageSubscriberOptions {
  store: OgImageStore;
  /** Public host without scheme (`jessie.romeos.cc`); null hides the link line. */
  host: string | null;
  generate?: (app: ResolvedApp, link: string | null) => Promise<Buffer>;
}

function isResolvedWebApp(view: CatalogEvent["current"]): view is ResolvedApp {
  return (
    view !== null &&
    (view as ResolvedApp).manifest !== undefined &&
    view.state === "installed" &&
    view.enabled &&
    (view as ResolvedApp).web != null
  );
}

/**
 * Catalog subscriber that keeps one social-card PNG per installed web app.
 * Fires on install, upgrade, enable and every boot (the catalog replays each
 * entry); the mtime check makes the replay a no-op. Never awaits the render
 * (`fireEvent` runs handlers serially and boot must not wait on resvg); the
 * uninstall cleanup is awaited because it is a single unlink. A per-app epoch
 * discards a render that finishes after a later event for the same app has
 * already started, so a slow render can neither overwrite a newer card nor
 * recreate one after uninstall.
 */
export function createAppOgImageSubscriber(opts: AppOgImageSubscriberOptions): SubscriberHandler {
  const generate = opts.generate ?? generateOgImage;

  // Every event for an app bumps its epoch; a render that finishes under an
  // older epoch than the one it started with is stale and is discarded, so a
  // slow render can neither overwrite a newer card nor recreate one after
  // uninstall. The epoch alone isn't enough, though: `store.write` is two
  // async steps (writeFile + rename), so a removal or a newer write could
  // still land between the check and the rename. Per-app `queues` serialize
  // every write and removal for an app so only one runs at a time, and a
  // write re-checks the epoch once it holds the queue.
  const epochs = new Map<string, number>();
  const bump = (appId: string) => {
    const next = (epochs.get(appId) ?? 0) + 1;
    epochs.set(appId, next);
    return next;
  };
  const queues = new Map<string, Promise<void>>();
  const enqueue = (appId: string, task: () => Promise<void>): Promise<void> => {
    const run = (queues.get(appId) ?? Promise.resolve()).then(task, task);
    queues.set(appId, run);
    return run;
  };

  return function appOgImageSubscriber(event: CatalogEvent) {
    const epoch = bump(event.appId);
    if (event.change === "removed") {
      // Cheap and deterministic, so awaited; only the resvg render below is
      // fire-and-forget.
      return enqueue(event.appId, () => opts.store.remove(event.appId)).catch((err: unknown) => {
        log.warn("failed to remove social card image", { appId: event.appId, error: String(err) });
      });
    }
    const app = event.current;
    if (!isResolvedWebApp(app)) return;

    void (async () => {
      const existing = await opts.store.stat(app.appId);
      if (existing && existing.mtimeMs > Date.parse(app.updatedAt)) return;
      const link = opts.host ? `${opts.host}/full/apps/${appIdToPathSegment(app.appId)}` : null;
      const png = await generate(app, link);
      await enqueue(app.appId, async () => {
        if (epochs.get(app.appId) !== epoch) return;
        await opts.store.write(app.appId, png);
        log.info("rendered social card image", { appId: app.appId });
      });
    })().catch((err: unknown) => {
      log.warn("social card image generation failed", {
        appId: app.appId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}
