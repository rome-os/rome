import type { AppCatalog } from "../apps/catalog.js";
import type { ResolvedApp } from "../apps/state.js";
import { getExternalRequestOrigin } from "../lib/request-origin.js";
import { DEFAULT_SOCIAL_IMAGE_URL, type SocialCard } from "../lib/social-meta.js";
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
 * card). Mirrors the SPA's own `getRoutedAppId` in packages/web.
 */
export function buildAppSocialCard(deps: AppSocialCardDeps, request: Request): SocialCard | null {
  const pathname = new URL(request.url).pathname;
  const appId = getRoutedAppId(pathname);
  if (appId === null) return null;
  const view = deps.appCatalog.get(appId);
  if (!isResolvedWebApp(view)) return null;

  const { origin } = getExternalRequestOrigin(request);
  return {
    title: view.displayName,
    description: view.manifest.description,
    url: `${origin}${pathname}`,
    imageUrl: DEFAULT_SOCIAL_IMAGE_URL,
  };
}
