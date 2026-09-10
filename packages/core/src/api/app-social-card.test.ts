import { describe, expect, it } from "@rstest/core";
import { DEFAULT_SOCIAL_IMAGE_URL } from "../lib/social-meta.js";
import { buildAppSocialCard, getRoutedAppId } from "./app-social-card.js";

function catalogWith(views: Record<string, unknown>) {
  return { get: (appId: string) => (views[appId] as never) ?? null };
}

const reddit = {
  appId: "reddit",
  state: "installed",
  enabled: true,
  displayName: "Reddit Radar",
  manifest: { id: "reddit", description: "Watches subreddits" },
  web: { displayName: "Reddit Radar" },
};

function req(path: string): Request {
  return new Request(`http://127.0.0.1:4141${path}`, {
    headers: { host: "jessie.romeos.cc", "x-forwarded-proto": "https" },
  });
}

describe("getRoutedAppId", () => {
  it("extracts the app id from embedded and full routes", () => {
    expect(getRoutedAppId("/apps/reddit")).toBe("reddit");
    expect(getRoutedAppId("/apps/reddit/")).toBe("reddit");
    expect(getRoutedAppId("/apps/reddit/posts/1")).toBe("reddit");
    expect(getRoutedAppId("/full/apps/reddit")).toBe("reddit");
    expect(getRoutedAppId("/full/apps/%40acme%2Fradar")).toBe("@acme/radar");
  });

  it("returns null for other paths and malformed ids", () => {
    expect(getRoutedAppId("/")).toBeNull();
    expect(getRoutedAppId("/apps")).toBeNull();
    expect(getRoutedAppId("/dashboard")).toBeNull();
    expect(getRoutedAppId("/apps/Not%20Valid")).toBeNull();
  });
});

describe("buildAppSocialCard", () => {
  it("builds a card for an installed app with a web bundle", () => {
    const card = buildAppSocialCard(
      { appCatalog: catalogWith({ reddit }) },
      req("/full/apps/reddit"),
    );
    expect(card).toEqual({
      title: "Reddit Radar",
      description: "Watches subreddits",
      url: "https://jessie.romeos.cc/full/apps/reddit",
      imageUrl: DEFAULT_SOCIAL_IMAGE_URL,
    });
  });

  it("returns null for unknown apps, non-app paths, and apps without a frontend", () => {
    const deps = {
      appCatalog: catalogWith({ reddit, headless: { ...reddit, appId: "headless", web: null } }),
    };
    expect(buildAppSocialCard(deps, req("/apps/nope"))).toBeNull();
    expect(buildAppSocialCard(deps, req("/dashboard"))).toBeNull();
    expect(buildAppSocialCard(deps, req("/apps/headless"))).toBeNull();
  });
});
