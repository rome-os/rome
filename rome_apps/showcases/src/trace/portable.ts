import type { TraceEventDto, TraceSnapshot } from "./types.js";

export const SHOWCASE_BUNDLE_SCHEMA = "rome.showcases.bundle";
export const SHOWCASE_BUNDLE_VERSION = 1;

export interface ShowcaseBundleTrace {
  id: string;
  title: string;
  description?: string | null;
  capturedAt: string;
  blocks: TraceEventDto[];
  snapshot?: TraceSnapshot;
  summary?: TraceSnapshot["summary"];
  metadata?: Record<string, unknown>;
}

export interface ShowcaseBundleCollection {
  id: string;
  title: string;
  description?: string | null;
  source?: string;
  traces: ShowcaseBundleTrace[];
}

export interface ShowcaseBundle {
  schema: typeof SHOWCASE_BUNDLE_SCHEMA;
  version: typeof SHOWCASE_BUNDLE_VERSION;
  exportedAt: string;
  collections: ShowcaseBundleCollection[];
}

export const SHOWCASE_PRESET_CATALOG_SCHEMA = "rome.showcases.presets";
export const SHOWCASE_PRESET_CATALOG_VERSION = 2;

/** A navigate payload for the SDK's `navigateRome` bridge. Kept structural here
 *  because portable.ts is shared with app-server code that must not import the
 *  web SDK; the frontend casts it to `NavigateRomePayload` at the call site. */
export type PresetNavigate = { path: string } & Record<string, unknown>;

export interface PresetCta {
  label: string;
  /** External / full-page link — rendered as an `<a href>`. */
  href?: string;
  /** Internal soft navigation via `navigateRome` — rendered as a button. */
  navigate?: PresetNavigate;
}

export interface PresetTryCta {
  label: string;
  /** Prefilled chat-composer draft (`navigateRome({ path: "chat/new", draft })`). */
  draft: string;
}

export interface PresetItem {
  id: string;
  title: string;
  description?: string | null;
  /** lucide-react icon name, e.g. "LineChart". */
  icon?: string | null;
  mainCta?: PresetCta;
  tryCta?: PresetTryCta;
  /** Whole-card click target — when set, the entire card becomes a link to this
   *  URL (e.g. the app's App Store listing). Inner CTAs keep their own actions. */
  cardHref?: string | null;
  /** "See how it was built" bundle URL. Absent/null hides the link. */
  traceUrl?: string | null;
}

export interface PresetCategory {
  id: string;
  title: string;
  items: PresetItem[];
}

/** A `rome.showcases.presets` document: server-driven categories of CTA cards. */
export interface PresetCatalog {
  schema: typeof SHOWCASE_PRESET_CATALOG_SCHEMA;
  version: typeof SHOWCASE_PRESET_CATALOG_VERSION;
  categories: PresetCategory[];
}

export const PRESET_ENDPOINT_CONTRACT = {
  catalog: {
    method: "GET",
    path: "/presets",
    responseSchema: SHOWCASE_PRESET_CATALOG_SCHEMA,
    responseVersion: SHOWCASE_PRESET_CATALOG_VERSION,
  },
  bundle: {
    method: "GET",
    path: "/presets/:id/bundle",
    responseSchema: SHOWCASE_BUNDLE_SCHEMA,
    responseVersion: SHOWCASE_BUNDLE_VERSION,
  },
} as const;

export function isShowcaseBundle(value: unknown): value is ShowcaseBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Partial<ShowcaseBundle>;
  return (
    bundle.schema === SHOWCASE_BUNDLE_SCHEMA &&
    bundle.version === SHOWCASE_BUNDLE_VERSION &&
    Array.isArray(bundle.collections)
  );
}
