import { describe, expect, it } from "@rstest/core";
import config from "../../rsbuild.config";

describe("rsbuild dev WebSocket proxy config", () => {
  const proxy = config.server?.proxy;

  it("keeps Host intact and stamps X-Forwarded-For on every proxied WebSocket route", () => {
    expect(proxy && typeof proxy === "object" && !Array.isArray(proxy)).toBe(true);
    if (!proxy || Array.isArray(proxy)) return;

    const wsRoutes = Object.entries(proxy).filter(
      ([, rule]) => typeof rule === "object" && rule !== null && rule.ws === true,
    );

    expect(wsRoutes.map(([route]) => route)).toEqual(
      expect.arrayContaining([
        "/ws/terminal",
        "/ws/events",
        "/ws/node",
        "/ws/voice-input",
        "/ws/voice-conversation",
        "/desktop-proxy",
      ]),
    );

    for (const [route, rule] of wsRoutes) {
      if (typeof rule !== "object" || rule === null) continue;
      // Rsbuild defaults `changeOrigin` to `true`, and its WebSocket `xfwd`
      // pass sets X-Forwarded-For/Port/Proto without X-Forwarded-Host.
      // Explicitly setting `changeOrigin: false` preserves `Host` so
      // `gateUpgrade` same-origin checks succeed while keeping XFF stamped.
      expect(rule.xfwd, `${route} must stamp X-Forwarded-For`).toBe(true);
      expect(rule.changeOrigin, `${route} must explicitly set changeOrigin: false`).toBe(false);
    }
  });
});
