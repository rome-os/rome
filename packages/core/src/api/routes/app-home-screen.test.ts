import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";
import { appHomeScreenRoutes } from "./app-home-screen.js";

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#6a5acd"/></svg>';

describe("home-screen routes", () => {
  let root: string;
  let app: Hono;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rome-app-home-screen-"));
    writeFileSync(join(root, "icon.svg"), ICON_SVG);
    const webApp = (appId: string, displayName: string, iconAbsolutePath?: string) => ({
      appId,
      displayName,
      manifest: {},
      updatedAt: "2026-09-23T00:00:00.000Z",
      web: { assetVersion: "abc123def456" },
      iconAbsolutePath,
    });
    const apps: Record<string, unknown> = {
      ttt: webApp("ttt", "Sevenfold Tic-Tac-Toe", join(root, "icon.svg")),
      "@acme/radar": webApp("@acme/radar", "Radar", join(root, "icon.svg")),
      plain: webApp("plain", "Plain"),
      headless: { appId: "headless", displayName: "Headless", manifest: {}, web: null },
    };
    const appCatalog = { get: (id: string) => apps[id] ?? null } as ApiDeps["appCatalog"];
    app = new Hono().route("/", appHomeScreenRoutes({ appCatalog }));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("GET /app-manifest/<seg>.webmanifest", () => {
    it("opens the app's fullscreen route under its own id, name and icon", async () => {
      const res = await app.request("/app-manifest/ttt.webmanifest");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/manifest+json");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(await res.json()).toMatchObject({
        id: "/full/apps/ttt",
        start_url: "/full/apps/ttt",
        scope: "/",
        name: "Sevenfold Tic-Tac-Toe",
        short_name: "Sevenfold Tic-Tac-Toe",
        display: "standalone",
        icons: [
          {
            src: "/app-icon/ttt.png?v=1790121600000",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/app-icon/ttt.png?v=1790121600000",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      });
    });

    it("keeps scoped ids encoded in every path", async () => {
      const res = await app.request("/app-manifest/%40acme%2Fradar.webmanifest");
      const manifest = (await res.json()) as { id: string; icons: { src: string }[] };
      expect(manifest.id).toBe("/full/apps/%40acme%2Fradar");
      expect(manifest.icons[0].src).toBe("/app-icon/%40acme%2Fradar.png?v=1790121600000");
    });

    it("falls back to Rome's icon when the app has none", async () => {
      const res = await app.request("/app-manifest/plain.webmanifest");
      const manifest = (await res.json()) as { icons: { src: string; purpose: string }[] };
      expect(manifest.icons).toEqual([
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ]);
    });

    it("404s for unknown apps, apps without a frontend and other shapes", async () => {
      expect((await app.request("/app-manifest/nope.webmanifest")).status).toBe(404);
      expect((await app.request("/app-manifest/headless.webmanifest")).status).toBe(404);
      expect((await app.request("/app-manifest/Bad%20Id.webmanifest")).status).toBe(404);
      expect((await app.request("/app-manifest/ttt.json")).status).toBe(404);
    });
  });

  describe("GET /app-icon/<seg>.png", () => {
    it("renders a 512 PNG with a long immutable cache", async () => {
      const res = await app.request("/app-icon/ttt.png?v=1790121600000");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      const png = Buffer.from(await res.arrayBuffer());
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      // IHDR width and height.
      expect(png.readUInt32BE(16)).toBe(512);
      expect(png.readUInt32BE(20)).toBe(512);
    });

    it("404s when the app has no icon, no frontend, or is unknown", async () => {
      expect((await app.request("/app-icon/plain.png")).status).toBe(404);
      expect((await app.request("/app-icon/headless.png")).status).toBe(404);
      expect((await app.request("/app-icon/nope.png")).status).toBe(404);
      expect((await app.request("/app-icon/ttt.jpg")).status).toBe(404);
    });
  });
});
