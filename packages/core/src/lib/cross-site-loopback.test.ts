import { describe, expect, it } from "@rstest/core";
import { isBrowserMutation, isCrossSiteLoopbackMutation } from "./cross-site-loopback.js";

function req(
  method: string,
  headers: Record<string, string | undefined>,
  url = "http://localhost:4141/api/x",
) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  };
}

describe("isCrossSiteLoopbackMutation", () => {
  it("never refuses a safe method", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(
        isCrossSiteLoopbackMutation(
          req(method, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
        ),
      ).toBe(false);
    }
  });

  it("refuses a page on another site", () => {
    expect(
      isCrossSiteLoopbackMutation(
        req("POST", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(true);
  });

  it("refuses a non-loopback Origin when the client sends no Fetch Metadata", () => {
    expect(isCrossSiteLoopbackMutation(req("POST", { origin: "https://evil.example" }))).toBe(true);
  });

  it("refuses a page on another loopback port, which browsers mark same-site", () => {
    expect(
      isCrossSiteLoopbackMutation(
        req("POST", { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-site" }),
      ),
    ).toBe(true);
    expect(isCrossSiteLoopbackMutation(req("DELETE", { origin: "http://localhost:8000" }))).toBe(
      true,
    );
  });

  it("refuses an opaque or unparseable Origin without same-origin Fetch Metadata", () => {
    expect(isCrossSiteLoopbackMutation(req("POST", { origin: "null" }))).toBe(true);
    expect(
      isCrossSiteLoopbackMutation(req("POST", { origin: "null", "sec-fetch-site": "cross-site" })),
    ).toBe(true);
    expect(isCrossSiteLoopbackMutation(req("POST", { origin: "not a url" }))).toBe(true);
  });

  it("refuses a DNS-rebound name even when it looks same-origin", () => {
    expect(
      isCrossSiteLoopbackMutation(
        req(
          "POST",
          { origin: "http://rebind.example:4141", "sec-fetch-site": "same-origin" },
          "http://rebind.example:4141/api/x",
        ),
      ),
    ).toBe(true);
  });

  it("serves the dashboard on its own origin", () => {
    expect(
      isCrossSiteLoopbackMutation(
        req("POST", { origin: "http://localhost:4141", "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(false);
    expect(isCrossSiteLoopbackMutation(req("POST", { origin: "http://localhost:4141" }))).toBe(
      false,
    );
  });

  it("serves a same-origin page that sends Origin null under no-referrer", () => {
    expect(
      isCrossSiteLoopbackMutation(req("POST", { origin: "null", "sec-fetch-site": "same-origin" })),
    ).toBe(false);
  });

  it("serves the dev server's proxy, which forwards the browser's same-origin metadata", () => {
    expect(
      isCrossSiteLoopbackMutation(
        req(
          "POST",
          { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
          "http://127.0.0.1:4141/api/x",
        ),
      ),
    ).toBe(false);
  });

  it("serves a caller that is not a browser", () => {
    expect(isCrossSiteLoopbackMutation(req("POST", {}))).toBe(false);
  });
});

describe("isBrowserMutation", () => {
  it("never refuses a safe method", () => {
    expect(isBrowserMutation(req("GET", { origin: "https://evil.example" }))).toBe(false);
  });

  it("refuses an unsafe method from any browser page", () => {
    expect(isBrowserMutation(req("POST", { origin: "https://evil.example" }))).toBe(true);
    expect(isBrowserMutation(req("PUT", { origin: "http://localhost:4141" }))).toBe(true);
    expect(isBrowserMutation(req("POST", { "sec-fetch-site": "same-site" }))).toBe(true);
  });

  it("serves a caller that is not a browser", () => {
    expect(isBrowserMutation(req("POST", {}))).toBe(false);
  });
});
