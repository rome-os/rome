import { describe, expect, it } from "@rstest/core";
import { desktopProxyRoutes } from "./desktop-proxy.js";

describe("desktopProxyRoutes", () => {
  it("returns 404 for ordinary HTTP on the WebSocket path", async () => {
    const app = desktopProxyRoutes();
    for (const path of ["/desktop-proxy", "/desktop-proxy/vnc.html", "/desktop-proxy/websockify"]) {
      const response = await app.request(`http://rome.example${path}`);
      expect(response.status).toBe(404);
    }
    expect(
      (await app.request("http://rome.example/desktop-proxy/websockify", { method: "POST" }))
        .status,
    ).toBe(404);
  });
});
