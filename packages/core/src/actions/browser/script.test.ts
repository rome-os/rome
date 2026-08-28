import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as browserRuntimeModule from "@rome-os/app-runtime/browser" with {
  rstest: "importActual",
};

const { readFileMock, runDiscoveredBrowserScriptMock } = rs.hoisted(() => ({
  readFileMock: rs.fn(),
  runDiscoveredBrowserScriptMock: rs.fn(),
}));

rs.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

rs.mock("@rome-os/app-runtime/browser", () => ({
  ...browserRuntimeModule,
  runDiscoveredBrowserScript: runDiscoveredBrowserScriptMock,
}));

import {
  buildBrowserScriptExpression,
  loadCachedScriptSource,
  runDiscoveredBrowserScript,
} from "./script.js";

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

  it("delegates discovered browser script execution to the shared app-runtime helper", async () => {
    const close = rs.fn().mockResolvedValue(undefined);
    runDiscoveredBrowserScriptMock.mockResolvedValue({
      endpoint: {
        name: "cdp-local-chromium",
        browserUrl: "http://127.0.0.1:9222",
      },
      close,
      result: ["ok"],
    });

    const capabilityDiscovery = {
      getBrowserEndpoints: () => [],
    } as never;
    const options = {
      pageUrl: "https://www.facebook.com/sfmoma/",
      scriptUrl: new URL("file:///tmp/browser-script-test.js"),
      entrypointExpression: "runScraper",
      args: [{ maxPosts: 2 }],
    };

    const result = await runDiscoveredBrowserScript<string[]>(capabilityDiscovery, options);

    expect(runDiscoveredBrowserScriptMock).toHaveBeenCalledWith(capabilityDiscovery, options);
    expect(result).toEqual({
      endpoint: {
        name: "cdp-local-chromium",
        browserUrl: "http://127.0.0.1:9222",
      },
      close,
      result: ["ok"],
    });
  });
});
