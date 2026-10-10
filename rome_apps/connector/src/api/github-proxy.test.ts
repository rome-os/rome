import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { githubProxyCall } from "./github-proxy.js";

describe("githubProxyCall", () => {
  afterEach(() => rs.restoreAllMocks());

  function sentHeaders(fetch: ReturnType<typeof rs.spyOn>): Headers {
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    return new Headers(init.headers);
  }

  it("lets a caller header replace a default spelled in a different case", async () => {
    const fetch = rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));

    await githubProxyCall({
      token: "gho_test",
      endpoint: "https://api.github.com/repos/o/r/actions/runs",
      method: "GET",
      headers: { "X-GitHub-API-Version": "2026-03-10", accept: "application/vnd.github.raw" },
    });

    const headers = sentHeaders(fetch);
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(headers.get("accept")).toBe("application/vnd.github.raw");
    expect(headers.get("authorization")).toBe("Bearer gho_test");
  });
});
