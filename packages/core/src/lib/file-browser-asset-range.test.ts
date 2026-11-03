import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAssetHandler, createFileGetHandler } from "./file-browser-server.js";

function oneSecondWav(): Buffer {
  const samples = 48_000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(samples, 24);
  wav.writeUInt32LE(samples * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

describe("file browser asset byte ranges", () => {
  let rootDir: string;
  let app: Hono;
  let audio: Buffer;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "rome-asset-range-"));
    mkdirSync(join(rootDir, "demo"));
    audio = oneSecondWav();
    writeFileSync(join(rootDir, "demo", "clip.wav"), audio);
    const scope = {
      assetBasePath: "/api/projects/asset",
      logicalRoot: "projects",
      rootDir,
    };
    app = new Hono();
    app.get("/api/projects/file", createFileGetHandler(scope));
    app.get("/api/projects/asset/:fileName", createAssetHandler(scope));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  async function assetUrl(): Promise<string> {
    const response = await app.request("/api/projects/file?path=projects/demo/clip.wav");
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata).toMatchObject({ kind: "audio", mimeType: "audio/wav", size: audio.length });
    expect(metadata.assetUrl).toBeTypeOf("string");
    return metadata.assetUrl;
  }

  it("serves the whole audio file without a Range header", async () => {
    const response = await app.request(await assetUrl());
    expect(response.status).toBe(200);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(audio);
  });

  it("serves a full 64 KiB chunk within the audio file", async () => {
    const response = await app.request(await assetUrl(), { headers: { Range: "bytes=0-65535" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-65535/${audio.length}`);
    expect(response.headers.get("Content-Length")).toBe("65536");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(audio.subarray(0, 65536));
  });

  it("serves the shorter final chunk when its requested end exceeds EOF", async () => {
    const response = await app.request(await assetUrl(), {
      headers: { Range: "bytes=65536-131071" },
    });
    const body = Buffer.from(await response.arrayBuffer());
    expect({ status: response.status, bytes: body.length }).toEqual({
      status: 206,
      bytes: audio.length - 65536,
    });
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 65536-${audio.length - 1}/${audio.length}`,
    );
    expect(response.headers.get("Content-Length")).toBe(String(audio.length - 65536));
    expect(body).toEqual(audio.subarray(65536));
  });

  it("rejects a range whose start is already at EOF", async () => {
    const response = await app.request(await assetUrl(), {
      headers: { Range: `bytes=${audio.length}-131071` },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${audio.length}`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it.each([
    ["bytes=65536-", 65536],
    ["bytes=-1024", 95020],
    ["bytes=-131072", 0],
    ["bytes=65536-96043", 65536],
    ["bytes=65536-96044", 65536],
  ] as const)("serves the remaining audio for %s", async (range, start) => {
    const response = await app.request(await assetUrl(), { headers: { Range: range } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${start}-${audio.length - 1}/${audio.length}`,
    );
    expect(response.headers.get("Content-Length")).toBe(String(audio.length - start));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(audio.subarray(start));
  });

  it.each([
    "bytes=131072-196607",
    "bytes=65536-65535",
    "bytes=-",
    "bytes=not-a-range",
  ])("rejects the unsatisfiable or invalid range %s", async (range) => {
    const response = await app.request(await assetUrl(), { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${audio.length}`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });
});
