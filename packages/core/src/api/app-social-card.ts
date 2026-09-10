import type { AppCatalog } from "../apps/catalog.js";
import type { OgImageStore } from "../apps/og/store.js";
import { appIdToPathSegment } from "../apps/packaging/app-id.js";
import type { ResolvedApp } from "../apps/state.js";
import { getExternalRequestOrigin } from "../lib/request-origin.js";
import type { SocialCard } from "../lib/social-meta.js";
import { decodeAppIdPathSegment, InvalidAppApiPathError } from "./helpers.js";

const APP_ROUTE_RE = /^\/(?:full\/)?apps\/([^/]+)(?:\/|$)/;

/** App id named by an `/apps/<id>` or `/full/apps/<id>` document path, else null. */
export function getRoutedAppId(pathname: string): string | null {
  const match = pathname.match(APP_ROUTE_RE);
  if (!match) return null;
  try {
    return decodeAppIdPathSegment(match[1]);
  } catch (err) {
    if (err instanceof InvalidAppApiPathError) return null;
    throw err;
  }
}

export interface AppSocialCardDeps {
  appCatalog: Pick<AppCatalog, "get">;
  ogImageStore: Pick<OgImageStore, "stat">;
}

function isResolvedWebApp(
  view: unknown,
): view is ResolvedApp & { web: NonNullable<ResolvedApp["web"]> } {
  return (
    !!view &&
    typeof view === "object" &&
    (view as ResolvedApp).manifest !== undefined &&
    (view as ResolvedApp).web != null
  );
}

/**
 * The social card for an app document request, or null when the request is
 * not for an installed app with a frontend (the shell then keeps its static
 * card). Mirrors the SPA's own `getRoutedAppId` in packages/web, minus its
 * reserved-id guard (`store`, `inbox`, …), which only affects client
 * routing — an unmatched id here just keeps the static card. imageUrl
 * points at the generated card when one exists; otherwise it is left
 * unset so the render keeps the shell's own og:image.
 */
export async function buildAppSocialCard(
  deps: AppSocialCardDeps,
  request: Request,
): Promise<SocialCard | null> {
  const pathname = new URL(request.url).pathname;
  const appId = getRoutedAppId(pathname);
  if (appId === null) return null;
  const view = deps.appCatalog.get(appId);
  if (!isResolvedWebApp(view)) return null;

  // Echoes the requested host on purpose: the crawler already holds this
  // URL; getInstanceOrigin would break loopback/tailnet previews.
  const { origin } = getExternalRequestOrigin(request);
  const image = await deps.ogImageStore.stat(appId);
  return {
    title: view.displayName,
    description: view.manifest.description,
    url: `${origin}${pathname}`,
    ...(image
      ? {
          imageUrl: `${origin}/app-og/${appIdToPathSegment(appId)}.png?v=${Math.floor(image.mtimeMs)}`,
        }
      : {}),
  };
}
