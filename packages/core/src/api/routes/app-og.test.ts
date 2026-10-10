import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createOgImageStore, type OgImageStore } from "../../apps/og/store.js";
import type { ApiDeps } from "../deps.js";
import { appOgRoutes } from "./app-og.js";

describe("GET /app-og/:appId.png", () => {
  let root: string;
  let app: Hono;
  let ogImageStore: OgImageStore;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "rome-app-og-"));
    ogImageStore = createOgImageStore(root);
    await ogImageStore.write("reddit", Buffer.from("png-bytes"));
    await ogImageStore.write("@acme/radar", Buffer.from("scoped"));
    const appCatalog = {
      get: (id: string) =>
        id === "reddit" || id === "@acme/radar" ? ({ appId: id } as never) : null,
    } as ApiDeps["appCatalog"];
    app = new Hono().route("/", appOgRoutes({ ogImageStore, appCatalog }));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the png with a long immutable cache", async () => {
    const res = await app.request("/app-og/reddit.png?v=123");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("png-bytes");
  });

  it("serves scoped ids from their encoded segment", async () => {
    const res = await app.request("/app-og/%40acme%2Fradar.png");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("scoped");
  });

  it("404s for missing images, bad ids and other shapes", async () => {
    expect((await app.request("/app-og/nope.png")).status).toBe(404);
    expect((await app.request("/app-og/Bad%20Id.png")).status).toBe(404);
    expect((await app.request("/app-og/reddit.jpg")).status).toBe(404);
    expect((await app.request("/app-og/reddit/extra.png")).status).toBe(404);
  });

  it("404s for a card whose app is no longer in the catalog", async () => {
    await ogImageStore.write("ghost", Buffer.from("orphan"));
    expect((await app.request("/app-og/ghost.png")).status).toBe(404);
  });
});
