import { z } from "zod";

/**
 * What the Desktop app is made from: the name, page and icon the Rome gives
 * the app's home-screen shortcut. They come from the Rome itself, never from
 * the page that asked, so a page cannot name or point a shim at will.
 */
export interface AppIdentity {
  name: string;
  /** The app's full-screen route on that Rome. */
  url: string;
  /** The icon as a PNG, or null when the Rome has none to give. */
  icon: Buffer | null;
}

const manifestSchema = z.object({
  name: z.string().trim().min(1),
  start_url: z.string().min(1),
  icons: z.array(z.object({ src: z.string().min(1) })).optional(),
});

/** An unscoped app id, as core's APP_ID_PATTERN (apps/packaging/app-id.ts). */
const APP_ID = /^[a-z][a-z0-9-]{0,63}$/;
// Core's listing grammar (apps/packaging/listing-id.ts) for scoped Store ids.
const LISTING_HANDLE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const LISTING_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

/** A slug, or a scoped Store id such as `@handle/slug`. Core validates the id again. */
function isAppId(value: string): boolean {
  if (!value.startsWith("@")) return APP_ID.test(value);
  const slash = value.indexOf("/");
  if (slash < 0) return false;
  const handle = value.slice(1, slash);
  const slug = value.slice(slash + 1);
  return LISTING_HANDLE.test(handle) && LISTING_SLUG.test(slug) && handle !== slug;
}

export function requireAppId(value: unknown): string {
  const id = z.string().parse(value);
  if (!isAppId(id)) throw new Error(`Not an app id: ${JSON.stringify(id).slice(0, 80)}`);
  return id;
}

function sameOrigin(raw: string, origin: string): URL {
  const url = new URL(raw, origin);
  if (url.origin !== origin) throw new Error("The app's page is on another site.");
  return url;
}

/** Reads the app's web manifest and icon from `origin`. */
export async function fetchAppIdentity(
  fetchImpl: (url: string) => Promise<Response>,
  origin: string,
  appId: string,
): Promise<AppIdentity> {
  const segment = encodeURIComponent(requireAppId(appId));
  const response = await fetchImpl(`${origin}/app-manifest/${segment}.webmanifest`);
  if (!response.ok) {
    throw new Error(`This app has no page to put on the Desktop (${response.status}).`);
  }
  const manifest = manifestSchema.parse(await response.json());
  const url = sameOrigin(manifest.start_url, origin);
  if (!url.pathname.startsWith("/full/apps/")) {
    throw new Error("The app's page is not an app page.");
  }

  let icon: Buffer | null = null;
  const src = manifest.icons?.[0]?.src;
  if (src) {
    const iconResponse = await fetchImpl(sameOrigin(src, origin).toString());
    if (iconResponse.ok) icon = Buffer.from(await iconResponse.arrayBuffer());
  }
  return { name: manifest.name, url: url.toString(), icon };
}
