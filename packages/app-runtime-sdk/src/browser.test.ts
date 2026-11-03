import { beforeEach, describe, expect, it, rs } from "@rstest/core";

const { readFileMock } = rs.hoisted(() => ({
  readFileMock: rs.fn(),
}));

rs.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

import {
  buildBrowserScriptExpression,
  isPageReadyForAutomation,
  loadCachedScriptSource,
  pickBrowserEndpoint,
} from "./browser.js";

describe("browser endpoint helpers", () => {
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

describe("browser script helpers", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });

  it("builds an expression that injects the script and preserves undefined args", () => {
    const expression = buildBrowserScriptExpression({
      scriptSource: "async function extractFacebookCommenters() { return []; }",
      entrypointExpression: "extractFacebookCommenters",
      args: [{ maxPosts: undefined, labels: ["a", "b"], "data-key": true }],
      autorunFlag: "__ROME_FACEBOOK_EXTRACT_USERS_AUTORUN__",
    });

    expect(expression).toContain('globalThis["__ROME_FACEBOOK_EXTRACT_USERS_AUTORUN__"] = false;');
    expect(expression).toContain(
      "const __romeBrowserScriptEntrypoint = extractFacebookCommenters;",
    );
    expect(expression).toContain(
      '__romeBrowserScriptEntrypoint({ maxPosts: undefined, labels: ["a", "b"], "data-key": true })',
    );
  });

  it("evicts a failed script load from the cache", async () => {
    readFileMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("async function retryable() { return 'ok'; }");

    const scriptUrl = new URL("file:///tmp/browser-script-retry-test.js");

    await expect(loadCachedScriptSource(scriptUrl)).rejects.toThrow("boom");
    await expect(loadCachedScriptSource(scriptUrl)).resolves.toContain("retryable");

    expect(readFileMock).toHaveBeenCalledTimes(2);
  });
});
