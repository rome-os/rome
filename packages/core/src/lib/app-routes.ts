import { appIdToPathSegment } from "@rome-os/app-runtime/app-id";

export type RomeAppShellMode = "embedded" | "full";

export function getAppRouteBase(appId: string, mode: RomeAppShellMode = "embedded"): string {
  const segment = appIdToPathSegment(appId);
  return mode === "full" ? `/full/apps/${segment}` : `/apps/${segment}`;
}

export function getAppHref(
  appId: string,
  path: readonly string[] = [],
  mode: RomeAppShellMode = "embedded",
): string {
  const routeBase = getAppRouteBase(appId, mode);
  if (path.length === 0) {
    return routeBase;
  }

  return `${routeBase}/${path.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function getEmbeddedAppHref(appId: string): string {
  return getAppHref(appId, [], "embedded");
}

export function getFullAppHref(appId: string): string {
  return getAppHref(appId, [], "full");
}
