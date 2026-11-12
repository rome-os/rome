// @rstest-environment jsdom

// Its own file: a bound bootstrap lasts for the module, as it does in an app bundle.
import { afterEach, describe, expect, it, rs } from "@rstest/core";

import { bindBootstrap, fetchAppApi, type RomeAppBootstrap } from "./index";

const bootstrapOf = (appId: string): RomeAppBootstrap => ({
  appId,
  version: "1.0.0",
  routeBase: `/apps/${appId}`,
  routePath: "",
  apiBase: `/api/apps/${appId}`,
  assetBase: `/app-assets/${appId}/1.0.0`,
  shell: { locale: "en-US", theme: "light", themeName: "ember", mode: "embedded" },
});

afterEach(() => {
  rs.unstubAllGlobals();
});

describe("bindBootstrap", () => {
  it("reads the window global until a bootstrap is bound", async () => {
    const fetchMock = rs.fn().mockResolvedValue(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);
    rs.stubGlobal("window", { __ROME_APP_BOOTSTRAP__: bootstrapOf("meals") } as never);

    await fetchAppApi("logs");

    expect(fetchMock).toHaveBeenCalledWith("/api/apps/meals/logs", undefined);
  });

  it("keeps this app's own API after another app's card writes the window global", async () => {
    const fetchMock = rs.fn().mockResolvedValue(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);
    rs.stubGlobal("window", { __ROME_APP_BOOTSTRAP__: bootstrapOf("meals") } as never);
    bindBootstrap(bootstrapOf("meals"));

    window.__ROME_APP_BOOTSTRAP__ = bootstrapOf("weather");
    await fetchAppApi("logs");

    expect(fetchMock).toHaveBeenCalledWith("/api/apps/meals/logs", undefined);
  });
});
