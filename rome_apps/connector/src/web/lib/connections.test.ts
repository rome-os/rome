import { describe, expect, it } from "@rstest/core";
import {
  buildConnectionViews,
  CATALOG,
  CATALOG_BY_SLUG,
  ROME_MANAGED_CATALOG,
  type ConnectedAccount,
} from "./connections.js";

function account(over: Partial<ConnectedAccount> & { toolkitSlug: string }): ConnectedAccount {
  return { id: `ca_${over.toolkitSlug}`, status: "ACTIVE", ...over };
}

describe("buildConnectionViews", () => {
  it("shows one card per toolkit when a provider has multiple connected accounts", () => {
    const views = buildConnectionViews([
      account({ id: "ca_1", toolkitSlug: "slack", status: "ACTIVE" }),
      account({ id: "ca_2", toolkitSlug: "slack", status: "INACTIVE" }),
      account({ id: "ca_3", toolkitSlug: "slack", status: "EXPIRED" }),
    ]);

    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("Slack");
  });

  it("collapses accounts whose toolkit slug differs only in case", () => {
    const views = buildConnectionViews([
      account({ id: "ca_1", toolkitSlug: "slack" }),
      account({ id: "ca_2", toolkitSlug: "SLACK" }),
    ]);

    expect(views).toHaveLength(1);
  });

  it("treats an app as reachable when any of its accounts is ACTIVE", () => {
    const views = buildConnectionViews([
      account({ id: "ca_1", toolkitSlug: "slack", status: "EXPIRED" }),
      account({ id: "ca_2", toolkitSlug: "slack", status: "ACTIVE" }),
    ]);

    expect(views[0].needsAttention).toBe(false);
  });

  it("flags an app as needing attention when none of its accounts is ACTIVE", () => {
    const views = buildConnectionViews([
      account({ id: "ca_1", toolkitSlug: "slack", status: "EXPIRED" }),
      account({ id: "ca_2", toolkitSlug: "slack", status: "INACTIVE" }),
    ]);

    expect(views).toHaveLength(1);
    expect(views[0].needsAttention).toBe(true);
  });

  it("keeps distinct toolkits as separate cards, in first-seen order", () => {
    const views = buildConnectionViews([
      account({ toolkitSlug: "gmail" }),
      account({ toolkitSlug: "slack" }),
      account({ toolkitSlug: "gmail" }),
    ]);

    expect(views.map((v) => v.name)).toEqual(["Gmail", "Slack"]);
  });

  it("falls back to a title-cased name for toolkits outside the catalog", () => {
    const views = buildConnectionViews([account({ toolkitSlug: "microsoft_teams" })]);

    expect(views[0].name).toBe("Microsoft Teams");
  });

  it("includes Supabase and Neon in the first-class connection catalog", () => {
    expect(CATALOG.map((entry) => entry.slug)).toEqual(
      expect.arrayContaining(["supabase", "neon"]),
    );
    expect(CATALOG_BY_SLUG.get("supabase")).toMatchObject({
      name: "Supabase",
      glyph: "supabase",
    });
    expect(CATALOG_BY_SLUG.get("neon")).toMatchObject({ name: "Neon", glyph: "neon" });
  });

  it("includes LinkedIn in the first-class connection catalog", () => {
    expect(CATALOG.map((entry) => entry.slug)).toEqual(expect.arrayContaining(["linkedin"]));
    expect(CATALOG_BY_SLUG.get("linkedin")).toMatchObject({
      name: "LinkedIn",
      glyph: "linkedin",
    });
  });

  it("uses a friendly name for a connected LinkedIn account", () => {
    const views = buildConnectionViews([account({ toolkitSlug: "linkedin" })]);

    expect(views.map((v) => v.name)).toEqual(["LinkedIn"]);
  });

  it("includes the Composio-managed-OAuth providers in the first-class catalog", () => {
    const slugs = CATALOG.map((entry) => entry.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        "outlook",
        "googlesheets",
        "googledocs",
        "googleslides",
        "googleads",
        "dropbox",
        "hubspot",
        "stripe",
      ]),
    );
    expect(CATALOG_BY_SLUG.get("outlook")).toMatchObject({ name: "Outlook", glyph: "outlook" });
    expect(CATALOG_BY_SLUG.get("googlesheets")).toMatchObject({ name: "Sheets", glyph: "sheets" });
    expect(CATALOG_BY_SLUG.get("googledocs")).toMatchObject({ name: "Docs", glyph: "docs" });
    expect(CATALOG_BY_SLUG.get("googleslides")).toMatchObject({
      name: "Slides",
      glyph: "slides",
    });
    expect(CATALOG_BY_SLUG.get("googleads")).toMatchObject({
      name: "Google Ads",
      glyph: "googleads",
    });
    expect(CATALOG_BY_SLUG.get("dropbox")).toMatchObject({ name: "Dropbox", glyph: "dropbox" });
    expect(CATALOG_BY_SLUG.get("hubspot")).toMatchObject({ name: "HubSpot", glyph: "hubspot" });
    expect(CATALOG_BY_SLUG.get("stripe")).toMatchObject({ name: "Stripe", glyph: "stripe" });
  });

  it("includes Meta Ads in the first-class connection catalog", () => {
    expect(CATALOG.map((entry) => entry.slug)).toEqual(expect.arrayContaining(["metaads"]));
    expect(CATALOG_BY_SLUG.get("metaads")).toMatchObject({
      name: "Meta Ads",
      glyph: "metaads",
    });
  });

  it("omits providers without Composio-managed auth from the catalog", () => {
    expect(CATALOG_BY_SLUG.has("twitter")).toBe(false);
  });

  it("uses friendly names for connected Google Slides, ads, Supabase, and Neon accounts", () => {
    const views = buildConnectionViews([
      account({ toolkitSlug: "googleslides" }),
      account({ toolkitSlug: "googleads" }),
      account({ toolkitSlug: "metaads" }),
      account({ toolkitSlug: "supabase" }),
      account({ toolkitSlug: "neon" }),
    ]);

    expect(views.map((v) => v.name)).toEqual([
      "Slides",
      "Google Ads",
      "Meta Ads",
      "Supabase",
      "Neon",
    ]);
  });
});

describe("Rome-managed providers", () => {
  it("marks GitHub and Slack as Rome-managed (brokered by Rome's integration, not Composio)", () => {
    expect(CATALOG_BY_SLUG.get("github")).toMatchObject({ name: "GitHub", romeManaged: true });
    expect(CATALOG_BY_SLUG.get("slack")).toMatchObject({ name: "Slack", romeManaged: true });
  });

  it("treats every other catalog provider as a normal Composio connect", () => {
    const managed = CATALOG.filter((e) => e.romeManaged).map((e) => e.slug);
    expect(managed).toEqual(["github", "slack"]);
  });

  it("exposes Rome-managed entries via ROME_MANAGED_CATALOG", () => {
    expect(ROME_MANAGED_CATALOG.map((e) => e.slug)).toEqual(["github", "slack"]);
  });

  it("carries the romeManaged flag onto connected GitHub and Slack views so they render as managed", () => {
    const [github] = buildConnectionViews([account({ toolkitSlug: "github" })]);
    expect(github).toMatchObject({ name: "GitHub", romeManaged: true });
    const [slack] = buildConnectionViews([account({ toolkitSlug: "slack" })]);
    expect(slack).toMatchObject({ name: "Slack", romeManaged: true });
  });

  it("leaves non-managed connections with romeManaged=false", () => {
    const [view] = buildConnectionViews([account({ toolkitSlug: "gmail" })]);
    expect(view.romeManaged).toBe(false);
  });
});
