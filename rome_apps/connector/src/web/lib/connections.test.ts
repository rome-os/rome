import { describe, expect, it } from "@rstest/core";
import {
  CATALOG,
  CATALOG_BY_SLUG,
  romeManagedConnectionWorking,
  isRomeSettingsLink,
  titleCase,
} from "./connections.js";

describe("catalog", () => {
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
});

describe("Rome-managed providers", () => {
  it("marks GitHub, Slack, and Shopify as Rome-managed (brokered by Rome's integration, not Composio)", () => {
    expect(CATALOG_BY_SLUG.get("github")).toMatchObject({ name: "GitHub", romeManaged: true });
    expect(CATALOG_BY_SLUG.get("slack")).toMatchObject({ name: "Slack", romeManaged: true });
    expect(CATALOG_BY_SLUG.get("shopify")).toMatchObject({ name: "Shopify", romeManaged: true });
  });

  it("treats every other catalog provider as a normal Composio connect", () => {
    const managed = CATALOG.filter((e) => e.romeManaged).map((e) => e.slug);
    expect(managed).toEqual(["github", "slack", "shopify"]);
  });
});

describe("romeManagedConnectionWorking", () => {
  it("counts only a working connection as connected", () => {
    expect(romeManagedConnectionWorking({ state: "working" })).toBe(true);
    // A broken connection is on file but its token is dead: the card keeps
    // offering the reconnect.
    expect(romeManagedConnectionWorking({ state: "broken" })).toBe(false);
    expect(romeManagedConnectionWorking({ state: null })).toBe(false);
    expect(romeManagedConnectionWorking(undefined)).toBe(false);
  });

  it("reads the grants of a host from before connection states", () => {
    expect(romeManagedConnectionWorking({ grants: { store: "authorized" } })).toBe(true);
    expect(romeManagedConnectionWorking({ grants: { store: "degraded" } })).toBe(false);
    expect(romeManagedConnectionWorking({ grants: { store: "unauthorized" } })).toBe(false);
  });

  it("trusts the state over the grants when a host sends both", () => {
    expect(romeManagedConnectionWorking({ state: "broken", grants: { store: "authorized" } })).toBe(
      false,
    );
  });
});

describe("titleCase", () => {
  it("names a toolkit outside the catalog from its slug", () => {
    expect(titleCase("microsoft_teams")).toBe("Microsoft Teams");
  });
});

describe("isRomeSettingsLink", () => {
  it("tells a dashboard Settings page from an OAuth start", () => {
    expect(isRomeSettingsLink("/settings/connections/shopify")).toBe(true);
    expect(isRomeSettingsLink("/api/oauth/github/start")).toBe(false);
    expect(isRomeSettingsLink("https://broker.example/authorize")).toBe(false);
  });
});
