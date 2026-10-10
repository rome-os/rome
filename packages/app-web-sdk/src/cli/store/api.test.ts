import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { getJson } from "./api.js";

afterEach(() => {
  rs.unstubAllGlobals();
});

function stubResponse(body: string, status: number, statusText: string) {
  rs.stubGlobal("fetch", rs.fn().mockResolvedValue(new Response(body, { status, statusText })));
}

describe("getJson errors", () => {
  it("shows the error field of a JSON error body", async () => {
    stubResponse(JSON.stringify({ error: "token expired" }), 401, "Unauthorized");
    await expect(getJson("https://rome.example", "/api/store/me")).rejects.toThrow(
      "401 token expired",
    );
  });

  it("shows a non-JSON error body as sent", async () => {
    stubResponse("<html>Bad Gateway</html>", 502, "Bad Gateway");
    await expect(getJson("https://rome.example", "/api/store/me")).rejects.toThrow(
      "502 <html>Bad Gateway</html>",
    );
  });

  it("falls back to the status text for an empty body", async () => {
    stubResponse("", 503, "Service Unavailable");
    await expect(getJson("https://rome.example", "/api/store/me")).rejects.toThrow(
      "503 Service Unavailable",
    );
  });
});
