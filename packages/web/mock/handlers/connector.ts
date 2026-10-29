import { http, HttpResponse } from "msw";
import type { ComposioAccount, ComposioCatalogEntry } from "@/lib/composio-services";

// The Connector app's API, as Settings › Connections reads it. The catalog
// mirrors the Connector's own (`rome_apps/connector/src/catalog.ts`), without
// the services Rome connects itself.
const catalog: ComposioCatalogEntry[] = [
  { slug: "gmail", name: "Gmail", scope: "Reads and sends your email.", glyph: "gmail" },
  { slug: "outlook", name: "Outlook", scope: "Reads and sends your email.", glyph: "outlook" },
  {
    slug: "googlecalendar",
    name: "Calendar",
    scope: "Reads your schedule and books time.",
    glyph: "calendar",
  },
  { slug: "notion", name: "Notion", scope: "Reads and writes your pages.", glyph: "notion" },
  { slug: "googledrive", name: "Drive", scope: "Finds and manages your files.", glyph: "drive" },
  {
    slug: "googlesheets",
    name: "Sheets",
    scope: "Reads and updates your spreadsheets.",
    glyph: "sheets",
  },
  { slug: "googledocs", name: "Docs", scope: "Reads and writes your documents.", glyph: "docs" },
  {
    slug: "googleslides",
    name: "Slides",
    scope: "Creates and updates your presentations.",
    glyph: "slides",
  },
  {
    slug: "googleads",
    name: "Google Ads",
    scope: "Manages campaigns, audiences, and reporting.",
    glyph: "googleads",
  },
  { slug: "dropbox", name: "Dropbox", scope: "Finds and manages your files.", glyph: "dropbox" },
  { slug: "linear", name: "Linear", scope: "Tracks issues and projects.", glyph: "linear" },
  { slug: "discord", name: "Discord", scope: "Reads and posts messages.", glyph: "discord" },
  {
    slug: "linkedin",
    name: "LinkedIn",
    scope: "Reads your network and shares posts.",
    glyph: "linkedin",
  },
  {
    slug: "metaads",
    name: "Meta Ads",
    scope: "Manages Meta ad campaigns and insights.",
    glyph: "metaads",
  },
  {
    slug: "supabase",
    name: "Supabase",
    scope: "Manages projects, databases, auth, storage, and SQL.",
    glyph: "supabase",
  },
  {
    slug: "neon",
    name: "Neon",
    scope: "Manages Postgres projects, branches, databases, and roles.",
    glyph: "neon",
  },
  { slug: "hubspot", name: "HubSpot", scope: "Tracks your contacts and deals.", glyph: "hubspot" },
  { slug: "stripe", name: "Stripe", scope: "Looks up payments and customers.", glyph: "stripe" },
  {
    slug: "otter_ai_mcp",
    name: "Otter.ai",
    scope: "Searches your meetings and reads their transcripts.",
    glyph: "otter",
  },
];

// One working connection and one whose access Composio no longer has.
const accounts: ComposioAccount[] = [
  { id: "ca_gmail", toolkitSlug: "gmail", status: "ACTIVE" },
  { id: "ca_notion", toolkitSlug: "notion", status: "EXPIRED" },
];

export const connectorHandlers = [
  http.get("/api/apps/connector/catalog", () => HttpResponse.json({ items: catalog })),
  http.get("/api/apps/connector/status", () =>
    HttpResponse.json({
      appId: "connector",
      version: "0.7.0",
      hasKey: true,
      webhookRegistered: true,
      relayConfigured: true,
    }),
  ),
  http.get("/api/apps/connector/connectors", () => HttpResponse.json({ items: accounts })),
  http.post("/api/apps/connector/connectors", async ({ request }) => {
    const { provider } = (await request.json()) as { provider?: string };
    if (accounts.some((account) => account.toolkitSlug === provider && account.status === "ACTIVE"))
      return HttpResponse.json({ provider, alreadyConnected: true });
    return HttpResponse.json({
      provider,
      csrfToken: "mock",
      authorizationUrl: `https://example.com/oauth/${provider}`,
    });
  }),
  http.delete("/api/apps/connector/connectors/:slug", ({ params }) => {
    const before = accounts.length;
    for (let i = accounts.length - 1; i >= 0; i--) {
      if (accounts[i]?.toolkitSlug === params.slug) accounts.splice(i, 1);
    }
    return HttpResponse.json({ ok: true, deleted: before - accounts.length });
  }),
  http.post("/api/apps/connector/webhook/register", () =>
    HttpResponse.json({ ok: true, webhookUrl: "https://ingest.example.com/h/mock" }),
  ),
];
