import { describe, it, expect } from "@rstest/core";
import { isSameOriginMutationRequest } from "./mutation-origin.js";

function req(headers: Record<string, string | undefined>, url = "https://rome.example/x") {
  return {
    url,
    headers: {
      get: (n: string) => headers[n.toLowerCase()] ?? null,
    },
  };
}

describe("isSameOriginMutationRequest", () => {
  it("accepts browser fetch metadata that marks the request as same-origin", () => {
    expect(
      isSameOriginMutationRequest(
        req({
          "sec-fetch-site": "same-origin",
          origin: "https://mismatch.example",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "rome.example",
        }),
      ),
    ).toBe(true);
  });

  it("accepts when the Origin header matches the external origin", () => {
    expect(isSameOriginMutationRequest(req({ origin: "https://rome.example" }))).toBe(true);
  });

  it("rejects when the Origin header points elsewhere", () => {
    expect(isSameOriginMutationRequest(req({ origin: "https://attacker.example" }))).toBe(false);
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(isSameOriginMutationRequest(req({ referer: "https://rome.example/page" }))).toBe(true);
  });

  it("rejects non-same-origin fetch metadata without matching origin evidence", () => {
    expect(isSameOriginMutationRequest(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginMutationRequest(req({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("rejects requests with neither Origin nor Referer", () => {
    expect(isSameOriginMutationRequest(req({}))).toBe(false);
  });

  it("rejects when Referer is not a valid URL", () => {
    expect(isSameOriginMutationRequest(req({ referer: "not-a-url" }))).toBe(false);
  });
});
