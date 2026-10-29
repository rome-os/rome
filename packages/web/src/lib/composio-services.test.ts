import { describe, expect, it } from "@rstest/core";
import { composioServiceRows, type ComposioCatalogEntry } from "@/lib/composio-services";

const catalog: ComposioCatalogEntry[] = [
  { slug: "gmail", name: "Gmail", scope: "Reads and sends your email.", glyph: "gmail" },
  { slug: "notion", name: "Notion", scope: "Reads and writes your pages.", glyph: "notion" },
  { slug: "linear", name: "Linear", scope: "Tracks issues and projects.", glyph: "linear" },
];

describe("composioServiceRows", () => {
  it("lists every catalog service as available when nothing is connected", () => {
    const rows = composioServiceRows(catalog, []);
    expect(rows.connected).toEqual([]);
    expect(rows.available.map((row) => row.slug)).toEqual(["gmail", "notion", "linear"]);
  });

  it("collapses accounts to one row per service, working while any account is active", () => {
    const rows = composioServiceRows(catalog, [
      { id: "a", toolkitSlug: "gmail", status: "EXPIRED" },
      { id: "b", toolkitSlug: "GMAIL", status: "ACTIVE" },
      { id: "c", toolkitSlug: "notion", status: "EXPIRED" },
    ]);
    expect(rows.connected.map((row) => [row.slug, row.needsAttention])).toEqual([
      ["gmail", false],
      ["notion", true],
    ]);
    expect(rows.available.map((row) => row.slug)).toEqual(["linear"]);
  });

  it("keeps a connected service the catalog no longer lists, so it can be disconnected", () => {
    const rows = composioServiceRows(catalog, [
      { id: "a", toolkitSlug: "asana", status: "ACTIVE" },
    ]);
    expect(rows.connected).toEqual([
      { slug: "asana", name: "asana", scope: "", glyph: "", needsAttention: false },
    ]);
  });

  it("leaves out the services Rome connects itself, and their bridged accounts", () => {
    const rows = composioServiceRows(
      [
        ...catalog,
        { slug: "github", name: "GitHub", scope: "", glyph: "github", romeManaged: true },
        { slug: "slack", name: "Slack", scope: "", glyph: "slack", romeManaged: true },
        { slug: "shopify", name: "Shopify", scope: "", glyph: "shopify", romeManaged: true },
      ],
      [
        { id: "a", toolkitSlug: "github", status: "ACTIVE" },
        { id: "b", toolkitSlug: "slack", status: "EXPIRED" },
        { id: "c", toolkitSlug: "Shopify", status: "ACTIVE" },
      ],
    );
    expect(rows.connected).toEqual([]);
    expect(rows.available.map((row) => row.slug)).toEqual(["gmail", "notion", "linear"]);
  });
});
