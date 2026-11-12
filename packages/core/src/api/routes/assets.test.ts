import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { storeAssetBytes } from "../../assets/store.js";
import { getAssetsDir } from "../../paths.js";
import { assetsRoutes } from "./assets.js";

const ID = "0123456789abcdef0123456789abcdef";

describe("GET /api/assets/:name", () => {
  let home: string;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rome-assets-route-"));
    rs.stubEnv("HOME", home);
    rs.stubEnv("ROME_PROFILE", "assets-route-test");
    app = new Hono().route("/api", assetsRoutes());
  });

  afterEach(() => {
    rs.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const store = (data: Buffer | string, name: string) =>
    storeAssetBytes(Buffer.from(data), name).then((stored) => stored);

  describe("names", () => {
    it.each([
      ["a traversal", "../x"],
      ["an encoded traversal", "%2e%2e"],
      ["an encoded slash", `${ID}%2f.png`],
      ["uppercase hex", `${ID.toUpperCase()}.png`],
      ["a short id", `${ID.slice(1)}.png`],
      ["a long id", `${ID}0.png`],
      ["no extension", ID],
      ["an uppercase extension", `${ID}.PNG`],
      ["a long extension", `${ID}.abcdefghi`],
      ["a nested path", `sub/${ID}.png`],
      ["a hidden temp name", ".tmp"],
    ])("answers 404 for %s", async (_label, name) => {
      await store("png", "x.png");
      const res = await app.request(`/api/assets/${name}`);
      expect(res.status).toBe(404);
    });

    it("has no listing route", async () => {
      await store("png", "x.png");
      expect((await app.request("/api/assets")).status).toBe(404);
      expect((await app.request("/api/assets/")).status).toBe(404);
    });

    it("answers 404 for a name that was never stored", async () => {
      expect((await app.request(`/api/assets/${ID}.png`)).status).toBe(404);
    });

    it("does not follow a symlink planted in the store", async () => {
      const secret = join(home, "secret.txt");
      writeFileSync(secret, "secret");
      mkdirSync(getAssetsDir(), { recursive: true });
      symlinkSync(secret, join(getAssetsDir(), `${ID}.png`));

      expect((await app.request(`/api/assets/${ID}.png`)).status).toBe(404);
    });

    it("answers 404 for a directory", async () => {
      mkdirSync(join(getAssetsDir(), `${ID}.png`), { recursive: true });
      expect((await app.request(`/api/assets/${ID}.png`)).status).toBe(404);
    });
  });

  describe("headers", () => {
    it("serves the bytes with immutable caching, an ETag and nosniff", async () => {
      const stored = await store("PNGBYTES", "image.png");
      const res = await app.request(`/api/assets/${stored.fileName}`);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("PNGBYTES");
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
      expect(res.headers.get("ETag")).toBe(`"${stored.id}"`);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Content-Length")).toBe("8");
      expect(res.headers.get("Content-Disposition")).toBe("inline");
    });

    it("answers 304 to a matching If-None-Match, with the caching headers", async () => {
      const stored = await store("PNGBYTES", "image.png");
      for (const validator of [
        `"${stored.id}"`,
        `W/"${stored.id}"`,
        `"other", "${stored.id}"`,
        "*",
      ]) {
        const res = await app.request(`/api/assets/${stored.fileName}`, {
          headers: { "If-None-Match": validator },
        });
        expect(res.status, validator).toBe(304);
        expect(res.headers.get("ETag")).toBe(`"${stored.id}"`);
        expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
        expect(await res.text()).toBe("");
      }
      const miss = await app.request(`/api/assets/${stored.fileName}`, {
        headers: { "If-None-Match": '"nope"' },
      });
      expect(miss.status).toBe(200);
    });

    it("sends a sandboxing CSP, except for a pdf", async () => {
      const png = await store("x", "a.png");
      const pdf = await store("x", "a.pdf");
      const csp = (await app.request(`/api/assets/${png.fileName}`)).headers.get(
        "Content-Security-Policy",
      );
      expect(csp).toBe(
        "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      );
      expect(
        (await app.request(`/api/assets/${pdf.fileName}`)).headers.get("Content-Security-Policy"),
      ).toBe("default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    });

    it.each([
      ["png", "image/png", "inline"],
      ["jpg", "image/jpeg", "inline"],
      ["svg", "image/svg+xml", "inline"],
      ["webp", "image/webp", "inline"],
      ["mp4", "video/mp4", "inline"],
      ["webm", "video/webm", "inline"],
      ["mp3", "audio/mpeg", "inline"],
      ["pdf", "application/pdf", "inline"],
      ["html", "text/html", "attachment"],
      ["htm", "text/html", "attachment"],
      ["js", "text/javascript", "attachment"],
      ["xml", "application/xml", "attachment"],
      ["txt", "text/plain", "attachment"],
      ["zip", "application/octet-stream", "attachment"],
      ["bin", "application/octet-stream", "attachment"],
      ["xyz", "application/octet-stream", "attachment"],
    ])("serves .%s as %s, %s", async (extension, type, disposition) => {
      const stored = await store("x", `file.${extension}`);
      const res = await app.request(`/api/assets/${stored.fileName}`);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")?.startsWith(type)).toBe(true);
      // The header names no file, so the page's `download` name wins.
      expect(res.headers.get("Content-Disposition")).toBe(disposition);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
  });

  describe("ranges", () => {
    it("serves 206 for a byte range of a video and 416 past its end", async () => {
      const data = Buffer.from("0123456789");
      const stored = await store(data, "clip.mp4");
      const url = `/api/assets/${stored.fileName}`;

      const part = await app.request(url, { headers: { Range: "bytes=2-5" } });
      expect(part.status).toBe(206);
      expect(part.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(part.headers.get("Content-Length")).toBe("4");
      expect(part.headers.get("ETag")).toBe(`"${stored.id}"`);
      expect(await part.text()).toBe("2345");

      const bad = await app.request(url, { headers: { Range: "bytes=50-60" } });
      expect(bad.status).toBe(416);
      expect(bad.headers.get("Content-Range")).toBe("bytes */10");
    });

    it("does not range a download-only type", async () => {
      const stored = await store("0123456789", "data.zip");
      const res = await app.request(`/api/assets/${stored.fileName}`, {
        headers: { Range: "bytes=2-5" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("0123456789");
    });
  });

  describe("thumbnails", () => {
    async function noisePng(size: number): Promise<Buffer> {
      const { default: sharp } = await import("sharp");
      return sharp(randomBytes(size * size * 3), {
        raw: { width: size, height: size, channels: 3 },
      })
        .png()
        .toBuffer();
    }

    it("serves a WebP thumbnail with a width ETag, and the original without ?w", async () => {
      const png = await noisePng(1200);
      const stored = await store(png, "shot.png");
      const url = `/api/assets/${stored.fileName}`;

      const thumb = await app.request(`${url}?w=900`);
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get("Content-Type")).toBe("image/webp");
      expect(thumb.headers.get("ETag")).toBe(`"${stored.id}-w900"`);
      expect(thumb.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
      expect(thumb.headers.get("Content-Disposition")).toBe("inline");
      const bytes = Buffer.from(await thumb.arrayBuffer());
      expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
      expect(bytes.length).toBeLessThan(png.length);

      const original = await app.request(url);
      expect(original.headers.get("Content-Type")).toBe("image/png");
      expect(original.headers.get("ETag")).toBe(`"${stored.id}"`);
    });

    it("answers 304 for the width ETag only on the matching width", async () => {
      const stored = await store(await noisePng(1000), "shot.png");
      const url = `/api/assets/${stored.fileName}`;
      const hit = await app.request(`${url}?w=600`, {
        headers: { "If-None-Match": `"${stored.id}-w600"` },
      });
      expect(hit.status).toBe(304);
      const other = await app.request(`${url}?w=900`, {
        headers: { "If-None-Match": `"${stored.id}-w600"` },
      });
      expect(other.status).toBe(200);
    });

    it("ignores an unsupported width and a type that is not resized", async () => {
      const stored = await store(await noisePng(200), "shot.png");
      const odd = await app.request(`/api/assets/${stored.fileName}?w=123`);
      expect(odd.headers.get("ETag")).toBe(`"${stored.id}"`);
      const svg = await store("<svg/>", "a.svg");
      const res = await app.request(`/api/assets/${svg.fileName}?w=900`);
      expect(res.headers.get("ETag")).toBe(`"${svg.id}"`);
      expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    });
  });
});
