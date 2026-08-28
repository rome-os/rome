import { afterEach, describe, it, expect } from "@rstest/core";
import { getExternalRequestOrigin } from "./request-origin.js";

function req(headers: Record<string, string | undefined>, url = "http://127.0.0.1:8787/x") {
  return {
    url,
    headers: {
      get: (n: string) => headers[n.toLowerCase()] ?? null,
    },
  };
}

describe("getExternalRequestOrigin", () => {
  const originalRomeCloudDomain = process.env.PANTHEON_DOMAIN;

  afterEach(() => {
    if (originalRomeCloudDomain === undefined) delete process.env.PANTHEON_DOMAIN;
    else process.env.PANTHEON_DOMAIN = originalRomeCloudDomain;
  });

  it("falls back to the request URL when no forwarded headers are set", () => {
    const out = getExternalRequestOrigin(req({}));
    expect(out.origin).toBe("http://127.0.0.1:8787");
    expect(out.protocol).toBe("http");
    expect(out.hostname).toBe("127.0.0.1");
  });

  it("prefers x-forwarded-proto and x-forwarded-host", () => {
    const out = getExternalRequestOrigin(
      req({ "x-forwarded-proto": "https", "x-forwarded-host": "rome.example" }),
    );
    expect(out.origin).toBe("https://rome.example");
    expect(out.protocol).toBe("https");
    expect(out.host).toBe("rome.example");
  });

  it("takes the first value of a comma-separated x-forwarded-host", () => {
    const out = getExternalRequestOrigin(
      req({ "x-forwarded-proto": "https", "x-forwarded-host": "a.example, b.example" }),
    );
    expect(out.host).toBe("a.example");
  });

  it("falls back to the Host header when x-forwarded-host is absent", () => {
    const out = getExternalRequestOrigin(req({ host: "inner.local:9000" }));
    expect(out.host).toBe("inner.local:9000");
  });

  it("strips trailing colon from x-forwarded-proto", () => {
    const out = getExternalRequestOrigin(req({ "x-forwarded-proto": "https:" }));
    expect(out.protocol).toBe("https");
  });

  it("ignores unparseable host values and falls back to the URL", () => {
    const out = getExternalRequestOrigin(
      req({ "x-forwarded-host": "   " }, "http://fallback.local/"),
    );
    expect(out.host).toBe("fallback.local");
  });

  it("treats Rome Cloud tenant hosts as https when an inner proxy reports http", () => {
    process.env.PANTHEON_DOMAIN = "rome-cloud.example";

    const out = getExternalRequestOrigin(
      req({
        "x-forwarded-proto": "http",
        "x-forwarded-host": "tenant.rome-cloud.example",
      }),
    );

    expect(out.origin).toBe("https://tenant.rome-cloud.example");
    expect(out.protocol).toBe("https");
  });

  it("does not force https for local Rome Cloud development domains", () => {
    process.env.PANTHEON_DOMAIN = "localhost";

    const out = getExternalRequestOrigin(
      req({
        "x-forwarded-proto": "http",
        "x-forwarded-host": "tenant.localhost",
      }),
    );

    expect(out.origin).toBe("http://tenant.localhost");
    expect(out.protocol).toBe("http");
  });
});
