import { describe, expect, it, rs } from "@rstest/core";
import { fetchWithoutRedirect } from "./http.js";

describe("fetchWithoutRedirect", () => {
  it("asks the native transport not to follow redirects and rejects the response", async () => {
    const fetchImpl = rs.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.romeos.cc/api/private" },
      });
    });
    await expect(
      fetchWithoutRedirect(
        fetchImpl as unknown as typeof fetch,
        "https://my-rome.romeos.cc/api/private",
        {},
        "https://my-rome.romeos.cc",
      ),
    ).rejects.toThrow("redirect response was blocked");
  });

  it("rejects a response reported from another origin", async () => {
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, "url", { value: "https://other.romeos.cc/api/private" });
    await expect(
      fetchWithoutRedirect(
        rs.fn(async () => response) as unknown as typeof fetch,
        "https://my-rome.romeos.cc/api/private",
        {},
        "https://my-rome.romeos.cc",
      ),
    ).rejects.toThrow("cross-origin response was blocked");
  });
});
