import type { AppCatalog } from "../apps/catalog.js";
import { HOME_SCREEN_ICON_SIZE } from "../apps/og/home-screen-icon.js";
import { hasRenderableIcon } from "../apps/og/subscriber.js";
import { appIdToPathSegment } from "../apps/packaging/app-id.js";
import type { ResolvedApp } from "../apps/state.js";
import type { AppIdentity } from "../lib/social-meta.js";
import { getRoutedAppId, isResolvedWebApp } from "./app-social-card.js";

// "Add to Home Screen" / "Install app" for a single app. Every page of the
// shell links Rome's own manifest (id "/", start_url "/"), so a shortcut saved
// from an app page used to open Rome's home page under Rome's icon. App
// document requests swap in a manifest of the app's own, whose start_url is
// the app's fullscreen route.

type WebApp = ResolvedApp & { web: NonNullable<ResolvedApp["web"]> };

function homeScreenIconUrl(appId: string, app: WebApp): string | undefined {
  if (!hasRenderableIcon(app)) return undefined;
  // Versioned by the install, not the web bundle: an icon can change in a
  // release that leaves the bundle's assetVersion alone.
  return `/app-icon/${appIdToPathSegment(appId)}.png?v=${Date.parse(app.updatedAt)}`;
}

/**
 * The home-screen identity for an app document request, or null when the
 * request is not for an installed app with a frontend (the shell then keeps
 * Rome's own manifest and icon). Same conditions as buildAppSocialCard.
 */
export function buildAppIdentity(
  deps: { appCatalog: Pick<AppCatalog, "get"> },
  request: Request,
): AppIdentity | null {
  const appId = getRoutedAppId(new URL(request.url).pathname);
  if (appId === null) return null;
  const view = deps.appCatalog.get(appId);
  if (!isResolvedWebApp(view)) return null;
  const iconUrl = homeScreenIconUrl(appId, view);
  return {
    name: view.displayName,
    manifestUrl: `/app-manifest/${appIdToPathSegment(appId)}.webmanifest`,
    ...(iconUrl ? { iconUrl } : {}),
  };
}

/**
 * Web app manifest for one app. `id` is per app so Android treats it as its
 * own install rather than as Rome's; `scope` stays "/" so the sign-in page a
 * fresh shortcut lands on stays inside the standalone window.
 */
export function buildAppWebManifest(appId: string, app: WebApp): Record<string, unknown> {
  const route = `/full/apps/${appIdToPathSegment(appId)}`;
  const iconUrl = homeScreenIconUrl(appId, app);
  const size = `${HOME_SCREEN_ICON_SIZE}x${HOME_SCREEN_ICON_SIZE}`;
  const icon = iconUrl
    ? { src: iconUrl, sizes: size, type: "image/png" }
    : { src: "/icon-512.png", sizes: "512x512", type: "image/png" };
  return {
    id: route,
    start_url: route,
    scope: "/",
    name: app.displayName,
    short_name: app.displayName,
    display: "standalone",
    background_color: "#f4f3ef",
    theme_color: "#f4f3ef",
    // The same full-bleed image serves as maskable too, as in Rome's own
    // manifest: Android then crops it to the launcher shape instead of
    // shrinking it onto a white plate. iOS reads apple-touch-icon instead.
    icons: (["any", "maskable"] as const).map((purpose) => ({ ...icon, purpose })),
  };
}
