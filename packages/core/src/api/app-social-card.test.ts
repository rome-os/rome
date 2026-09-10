import { describe, expect, it } from "@rstest/core";
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
  const storeWith = (mtimeMs: number | null) => ({
    stat: async () => (mtimeMs === null ? null : { mtimeMs }),
  });

  it("points at the generated image when one exists", async () => {
    const deps = { appCatalog: catalogWith({ reddit }), ogImageStore: storeWith(1757400000123.4) };
    const card = await buildAppSocialCard(deps, req("/full/apps/reddit"));
    expect(card).toEqual({
      title: "Reddit Radar",
      description: "Watches subreddits",
      url: "https://jessie.romeos.cc/full/apps/reddit",
      imageUrl: "https://jessie.romeos.cc/app-og/reddit.png?v=1757400000123",
    });
  });

  it("leaves imageUrl unset before the first render so the shell's og:image is kept", async () => {
    const deps = { appCatalog: catalogWith({ reddit }), ogImageStore: storeWith(null) };
    const card = await buildAppSocialCard(deps, req("/apps/reddit"));
    expect(card).toEqual({
      title: "Reddit Radar",
      description: "Watches subreddits",
      url: "https://jessie.romeos.cc/apps/reddit",
    });
    expect(card).not.toHaveProperty("imageUrl");
  });

  it("returns null for unknown apps, non-app paths, and apps without a frontend", async () => {
    const deps = {
      appCatalog: catalogWith({ reddit, headless: { ...reddit, appId: "headless", web: null } }),
      ogImageStore: storeWith(null),
    };
    expect(await buildAppSocialCard(deps, req("/apps/nope"))).toBeNull();
    expect(await buildAppSocialCard(deps, req("/dashboard"))).toBeNull();
    expect(await buildAppSocialCard(deps, req("/apps/headless"))).toBeNull();
  });
});
