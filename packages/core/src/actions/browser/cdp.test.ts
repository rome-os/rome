import { describe, expect, it } from "@rstest/core";
import { isPageReadyForAutomation, pickBrowserEndpoint } from "./cdp.js";

describe("facebook CDP helpers", () => {
  it("prefers the local Chromium endpoint when one is discovered", () => {
    const endpoint = pickBrowserEndpoint([
      {
        name: "cdp-remote-browser",
        browserUrl: "http://100.64.0.2:9222",
      },
      {
        name: "cdp-local-chromium",
        browserUrl: "http://127.0.0.1:9222",
      },
    ]);

    expect(endpoint).toEqual({
      name: "cdp-local-chromium",
      browserUrl: "http://127.0.0.1:9222",
    });
  });

  it("falls back to the first alphabetical endpoint when no local browser exists", () => {
    const endpoint = pickBrowserEndpoint([
      {
        name: "cdp-zeta-browser",
        browserUrl: "http://100.64.0.4:9222",
      },
      {
        name: "cdp-alpha-browser",
        browserUrl: "http://100.64.0.3:9222",
      },
    ]);

    expect(endpoint).toEqual({
      name: "cdp-alpha-browser",
      browserUrl: "http://100.64.0.3:9222",
    });
  });

  it("does not treat about:blank as automation-ready", () => {
    expect(
      isPageReadyForAutomation({
        href: "about:blank",
        readyState: "complete",
      }),
    ).toBe(false);
  });

  it("requires a real page URL plus an interactive or complete document", () => {
    expect(
      isPageReadyForAutomation({
        href: "https://www.facebook.com/deYoungMuseum/",
        readyState: "loading",
      }),
    ).toBe(false);

    expect(
      isPageReadyForAutomation({
        href: "https://www.facebook.com/deYoungMuseum/",
        readyState: "interactive",
      }),
    ).toBe(true);
  });
});
