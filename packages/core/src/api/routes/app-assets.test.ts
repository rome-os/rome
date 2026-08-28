import { describe, expect, it, afterEach, beforeEach } from "@rstest/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { appAssetsRoutes } from "./app-assets.js";
import type { ApiDeps } from "../deps.js";

const MEDIA_ASSET_TYPES: Array<[string, string]> = [
  ["css", "text/css; charset=utf-8"],
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["jsonld", "application/ld+json; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["wasm", "application/wasm"],
  ["webmanifest", "application/manifest+json; charset=utf-8"],
  ["xhtml", "application/xhtml+xml; charset=utf-8"],
  ["xml", "application/xml; charset=utf-8"],
  ["apng", "image/apng"],
  ["avif", "image/avif"],
  ["gif", "image/gif"],
  ["ico", "image/vnd.microsoft.icon"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["svg", "image/svg+xml; charset=utf-8"],
  ["webp", "image/webp"],
  ["m4v", "video/x-m4v"],
  ["mov", "video/quicktime"],
  ["mp4", "video/mp4"],
  ["ogv", "video/ogg"],
  ["webm", "video/webm"],
  ["aac", "audio/aac"],
  ["flac", "audio/flac"],
  ["m4a", "audio/mp4"],
  ["mp3", "audio/mpeg"],
  ["oga", "audio/ogg"],
  ["ogg", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["wav", "audio/wav"],
  ["weba", "audio/webm"],
  ["eot", "application/vnd.ms-fontobject"],
  ["otf", "font/otf"],
  ["ttf", "font/ttf"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["pdf", "application/pdf"],
];

describe("GET /app-assets/:appId/:version/*", () => {
  let sandboxDir: string;
  let app: Hono;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "rome-app-assets-"));
    const assetDir = join(sandboxDir, "dist", "cards");
    mkdirSync(assetDir, { recursive: true });
    for (const [extension] of MEDIA_ASSET_TYPES) {
      writeFileSync(join(assetDir, `ace.${extension}`), new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    }

    const appCatalog = {
      get(appId: string) {
        if (appId !== "deck") return null;
        return {
          manifest: { id: "deck", name: "Deck" },
          web: {
            assetVersion: "1.0.0",
            distPath: join(sandboxDir, "dist"),
          },
        };
      },
    } as ApiDeps["appCatalog"];

    app = new Hono().route("/", appAssetsRoutes({ appCatalog }));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it.each(
    MEDIA_ASSET_TYPES,
  )("serves %s assets with the %s content type", async (extension, contentType) => {
    const res = await app.request(`/app-assets/deck/1.0.0/cards/ace.${extension}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(contentType);
  });

  it("falls back to application/octet-stream for unknown asset types", async () => {
    writeFileSync(join(sandboxDir, "dist", "cards", "ace.unknown"), "unknown");

    const res = await app.request("/app-assets/deck/1.0.0/cards/ace.unknown");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });
});
