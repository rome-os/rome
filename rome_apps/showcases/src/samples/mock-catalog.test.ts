import { describe, expect, it } from "@rstest/core";
import { MOCK_PRESET_CATALOG } from "./mock-catalog.js";
import {
  SHOWCASE_PRESET_CATALOG_SCHEMA,
  SHOWCASE_PRESET_CATALOG_VERSION,
} from "../trace/portable.js";

describe("MOCK_PRESET_CATALOG", () => {
  it("is a v2 showcases catalog document", () => {
    expect(MOCK_PRESET_CATALOG.schema).toBe(SHOWCASE_PRESET_CATALOG_SCHEMA);
    expect(MOCK_PRESET_CATALOG.version).toBe(SHOWCASE_PRESET_CATALOG_VERSION);
    expect(SHOWCASE_PRESET_CATALOG_VERSION).toBe(2);
  });

  it("exposes System plus the six content categories, in order", () => {
    expect(MOCK_PRESET_CATALOG.categories.map((c) => c.id)).toEqual([
      "system",
      "lifestyle",
      "social",
      "travel",
      "finance",
      "education",
      "fun",
    ]);
  });

  it("gives every item a title and well-formed optional CTAs", () => {
    for (const category of MOCK_PRESET_CATALOG.categories) {
      expect(category.items.length).toBeGreaterThan(0);
      for (const item of category.items) {
        expect(item.id).toBeTruthy();
        expect(item.title).toBeTruthy();
        if (item.mainCta) {
          expect(item.mainCta.label).toBeTruthy();
          // a main CTA is either an external link or an internal navigation
          expect(Boolean(item.mainCta.href) || Boolean(item.mainCta.navigate)).toBe(true);
        }
        if (item.tryCta) {
          expect(item.tryCta.label).toBeTruthy();
          expect(item.tryCta.draft).toBeTruthy();
        }
      }
    }
  });

  it("wires only published build traces", () => {
    const items = MOCK_PRESET_CATALOG.categories.flatMap((c) => c.items);
    const colorPals = items.find((item) => item.id === "color-pals");

    expect(colorPals?.traceUrl).toBe(
      "https://demo.romeos.cc/share/TMLGxMOAWTOAS_RlkUYyvfHOUE6mPB1O7CHvGHRWqJw",
    );

    for (const item of items.filter((item) => item.id !== "color-pals")) {
      expect(item.traceUrl ?? null).toBeNull();
    }
  });

  it("points the Connect card at the Connector app and offers an app-store card", () => {
    const system = MOCK_PRESET_CATALOG.categories.find((c) => c.id === "system");
    expect(system).toBeDefined();

    const connect = system?.items.find((i) => i.id === "connect-apps");
    expect(connect?.mainCta?.href).toBe("/apps/connector");

    const store = system?.items.find((i) => i.id === "browse-apps");
    expect(store?.mainCta?.href).toBe("https://romeos.cc/store");
  });

  it("links each app card to the demo full-page app route", () => {
    const appItems = MOCK_PRESET_CATALOG.categories
      .filter((c) => c.id !== "system")
      .flatMap((c) => c.items);
    expect(appItems.length).toBe(14);
    for (const item of appItems) {
      expect(item.mainCta?.href).toMatch(
        /^https:\/\/(?:demo\.romeos\.cc|demo\.r\.amantru\.com)\/full\/apps\/[a-z0-9-]+$/,
      );
    }
  });

  it("makes each app card click through to its App Store listing, with a Preview CTA", () => {
    const appItems = MOCK_PRESET_CATALOG.categories
      .filter((c) => c.id !== "system")
      .flatMap((c) => c.items);
    for (const item of appItems) {
      expect(item.cardHref).toBe(`https://romeos.cc/store/${item.id}`);
      expect(item.mainCta?.label).toBe("Preview app");
    }
  });

  it("does not make System cards click through at the card level", () => {
    const system = MOCK_PRESET_CATALOG.categories.find((c) => c.id === "system");
    for (const item of system?.items ?? []) {
      expect(item.cardHref ?? null).toBeNull();
    }
  });
});
