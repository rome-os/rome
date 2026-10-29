import { SUPPORTED_CONNECTORS } from "@rome-os/app-runtime";

// The connectable catalog, shared by the Connector's API (Settings ›
// Connections reads it through the `catalog` route) and its web page. It sits
// outside `web/` because the API is compiled file by file, while `web/` ships
// as one bundle with no `lib/` module the API could import at runtime.

/** A third-party app Rome can work in on the owner's behalf. Keyed by Composio
    toolkit slug, but the slug never reaches the owner — only `name`/`scope`. */
export interface CatalogEntry {
  slug: string;
  name: string;
  scope: string;
  glyph: string;
  /** Brokered by Rome's own integration (Rome Cloud OAuth), not Composio's connect
      flow. The connector never offers a Composio "Connect" for these — it routes
      the owner to Settings → Connections, and a connection bridged from the Rome
      token surfaces here as "Connected via Rome". Keeps a single integration per
      provider no matter which entry point the owner starts from. */
  romeManaged?: boolean;
}

/** Per-toolkit UI fields the shared catalog doesn't carry. Keyed by the SDK's
    `SUPPORTED_CONNECTORS` slugs so the *set* of connectable toolkits has one
    source of truth: a toolkit added to the SDK without a presentation entry here
    fails the drift guard in `shared.test.ts`, and the slug → name mapping comes
    from the SDK, not a second hand-maintained list. */
interface CatalogPresentation {
  scope: string;
  glyph: string;
  romeManaged?: boolean;
}

const CATALOG_PRESENTATION: Record<string, CatalogPresentation> = {
  gmail: { scope: "Reads and sends your email.", glyph: "gmail" },
  outlook: { scope: "Reads and sends your email.", glyph: "outlook" },
  googlecalendar: { scope: "Reads your schedule and books time.", glyph: "calendar" },
  github: {
    scope: "Powers git, the shell, and GitHub tools for your agents.",
    glyph: "github",
    romeManaged: true,
  },
  slack: { scope: "Reads and posts messages.", glyph: "slack", romeManaged: true },
  notion: { scope: "Reads and writes your pages.", glyph: "notion" },
  googledrive: { scope: "Finds and manages your files.", glyph: "drive" },
  googlesheets: { scope: "Reads and updates your spreadsheets.", glyph: "sheets" },
  googledocs: { scope: "Reads and writes your documents.", glyph: "docs" },
  googleslides: { scope: "Creates and updates your presentations.", glyph: "slides" },
  googleads: { scope: "Manages campaigns, audiences, and reporting.", glyph: "googleads" },
  dropbox: { scope: "Finds and manages your files.", glyph: "dropbox" },
  linear: { scope: "Tracks issues and projects.", glyph: "linear" },
  discord: { scope: "Reads and posts messages.", glyph: "discord" },
  linkedin: { scope: "Reads your network and shares posts.", glyph: "linkedin" },
  metaads: { scope: "Manages Meta ad campaigns and insights.", glyph: "metaads" },
  supabase: { scope: "Manages projects, databases, auth, storage, and SQL.", glyph: "supabase" },
  neon: { scope: "Manages Postgres projects, branches, databases, and roles.", glyph: "neon" },
  hubspot: { scope: "Tracks your contacts and deals.", glyph: "hubspot" },
  stripe: { scope: "Looks up payments and customers.", glyph: "stripe" },
  shopify: {
    scope: "Updates your store's products and inventory, and reads orders.",
    glyph: "shopify",
    romeManaged: true,
  },
  otter_ai_mcp: { scope: "Searches your meetings and reads their transcripts.", glyph: "otter" },
};

export const CATALOG: CatalogEntry[] = SUPPORTED_CONNECTORS.map((connector) => {
  const presentation = CATALOG_PRESENTATION[connector.toolkit];
  if (!presentation) {
    throw new Error(`connector catalog: no presentation entry for toolkit "${connector.toolkit}"`);
  }
  return {
    slug: connector.toolkit,
    name: connector.displayName,
    scope: presentation.scope,
    glyph: presentation.glyph,
    ...(presentation.romeManaged ? { romeManaged: true } : {}),
  };
});
