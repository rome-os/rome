import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import {
  createAssetHandler,
  createFileGetHandler,
  createFileWatchEventsHandler,
  createResolveHandler,
  type FileBrowserScope,
} from "./file-browser-server.js";

// File watch streams over real chokidar on a real temp directory (edge-only
// fakes, #763): events arrive because files actually change on disk. The only
// fake is the wall clock — setInterval/clearInterval, scoped to the tests
// that drive the 60s heartbeat — and chokidar is pinned to native watching
// (CHOKIDAR_USEPOLLING=0), because polling mode detects changes via interval
// timers and would deadlock under the fake clock. Lifecycle is asserted
// through the SSE stream itself (ready/change/ping chunks, stream
// completion), not by spying on watcher internals.

type SseEvent = { event: string; data: string };

function parseSseChunk(chunk: string): SseEvent[] {
  return chunk
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /(?:^|\n)event: (.+)/.exec(block)?.[1] ?? "";
      const data = /(?:^|\n)data: (.+)/.exec(block)?.[1] ?? "";
      return { event, data };
    });
}

describe("file browser event streams", () => {
  let rootDir = "";
  let handler: ReturnType<typeof createFileWatchEventsHandler>;
  let savedUsePolling: string | undefined;

  /** Fakes only the heartbeat cadence. Call before opening the stream (the
   *  handler registers its interval at stream start). Safe only because the
   *  watcher is pinned to native (non-polling) mode in beforeEach. */
  const useHeartbeatClock = () => rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

  beforeEach(() => {
    savedUsePolling = process.env.CHOKIDAR_USEPOLLING;
    // Polling mode detects changes via interval timers, which the heartbeat
    // tests fake — force native watching regardless of the ambient env.
    process.env.CHOKIDAR_USEPOLLING = "0";
    rootDir = mkdtempSync(join(tmpdir(), "rome-file-watch-"));
    handler = createFileWatchEventsHandler({
      assetBasePath: "/asset",
      logicalRoot: "projects",
      rootDir,
    });
  });

  afterEach(() => {
    rs.useRealTimers();
    if (savedUsePolling === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = savedUsePolling;
    rmSync(rootDir, { recursive: true, force: true });
  });

  function openEventStream(signal = new AbortController().signal): {
    reader: ReadableStreamDefaultReader<Uint8Array>;
  } {
    const url = "http://localhost/projects/events";
    const response = handler({
      req: { raw: new Request(url, { signal }), url },
    } as Parameters<typeof handler>[0]) as Response;
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.body).not.toBeNull();
    return { reader: response.body!.getReader() };
  }

  async function readSseChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const result = await reader.read();
    expect(result.done).toBe(false);
    return new TextDecoder().decode(result.value);
  }

  /** Reads chunks until an event with the given name arrives, returning every
   *  event seen along the way (the matching one last). Fails if the stream
   *  ends first. */
  async function readUntilEvent(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    eventName: string,
  ): Promise<SseEvent[]> {
    const seen: SseEvent[] = [];
    for (;;) {
      const result = await reader.read();
      expect(result.done).toBe(false);
      seen.push(...parseSseChunk(new TextDecoder().decode(result.value)));
      if (seen.some((event) => event.event === eventName)) return seen;
    }
  }

  it("emits ready, then streams change events for real file writes", async () => {
    const { reader } = openEventStream();
    await expect(readSseChunk(reader)).resolves.toContain("event: ready");

    writeFileSync(join(rootDir, "hello.txt"), "hi\n");

    const seen = await readUntilEvent(reader, "change");
    const change = seen.find((event) => event.event === "change")!;
    expect(JSON.parse(change.data)).toMatchObject({
      kind: "add",
      logicalRoot: "projects",
      path: "projects/hello.txt",
    });

    await reader.cancel();
  });

  it("does not stream events for ignored entries", async () => {
    const { reader } = openEventStream();
    await expect(readSseChunk(reader)).resolves.toContain("event: ready");

    // Dot-entries are ignored; the visible file written afterwards must be
    // the first (and only) change event the subscriber sees.
    writeFileSync(join(rootDir, ".hidden.txt"), "secret\n");
    writeFileSync(join(rootDir, "visible.txt"), "hi\n");

    const seen = await readUntilEvent(reader, "change");
    const changes = seen.filter((event) => event.event === "change");
    expect(changes).toHaveLength(1);
    expect(JSON.parse(changes[0].data).path).toBe("projects/visible.txt");

    await reader.cancel();
  });

  it("keeps healthy event streams open while sending heartbeats", async () => {
    useHeartbeatClock();
    const { reader } = openEventStream();
    await expect(readSseChunk(reader)).resolves.toContain("event: ready");

    const firstPingRead = readSseChunk(reader);
    await rs.advanceTimersByTimeAsync(60_000);
    await expect(firstPingRead).resolves.toContain("event: ping");

    const secondPingRead = readSseChunk(reader);
    await rs.advanceTimersByTimeAsync(60_000);
    await expect(secondPingRead).resolves.toContain("event: ping");

    await reader.cancel();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("keeps serving other subscribers when one stream is canceled, and new subscribers after all leave", async () => {
    const first = openEventStream();
    const second = openEventStream();
    await expect(readSseChunk(first.reader)).resolves.toContain("event: ready");
    await expect(readSseChunk(second.reader)).resolves.toContain("event: ready");

    await first.reader.cancel();

    writeFileSync(join(rootDir, "after-first-cancel.txt"), "hi\n");
    const seen = await readUntilEvent(second.reader, "change");
    expect(JSON.parse(seen.at(-1)!.data).path).toBe("projects/after-first-cancel.txt");

    await second.reader.cancel();

    // With no subscribers left the watcher goes idle; a fresh stream must
    // still come up and deliver events.
    const third = openEventStream();
    await expect(readSseChunk(third.reader)).resolves.toContain("event: ready");
    writeFileSync(join(rootDir, "after-all-cancel.txt"), "hi\n");
    const reseen = await readUntilEvent(third.reader, "change");
    expect(JSON.parse(reseen.at(-1)!.data).path).toBe("projects/after-all-cancel.txt");
    await third.reader.cancel();
  });

  it("tears down instead of queuing heartbeats when a write stays backpressured", async () => {
    useHeartbeatClock();
    const { reader } = openEventStream();
    await expect(readSseChunk(reader)).resolves.toContain("event: ready");

    // Nobody reads: the first ping stays in-flight, and after two more
    // heartbeat strikes the stream is torn down rather than queuing forever.
    await rs.advanceTimersByTimeAsync(60_000);
    await rs.advanceTimersByTimeAsync(180_000);

    const unreadPing = await readSseChunk(reader);
    expect(unreadPing).toContain("event: ping");
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("ends the stream when the request aborts", async () => {
    useHeartbeatClock();
    const abortController = new AbortController();
    const { reader } = openEventStream(abortController.signal);
    await expect(readSseChunk(reader)).resolves.toContain("event: ready");

    abortController.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });

    // No heartbeat survives the abort.
    await rs.advanceTimersByTimeAsync(120_000);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("ends the stream when the request aborts before the watcher is ready", async () => {
    useHeartbeatClock();
    const abortController = new AbortController();
    const { reader } = openEventStream(abortController.signal);

    abortController.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });

    await rs.advanceTimersByTimeAsync(120_000);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});

describe("file browser asset revalidation", () => {
  let rootDir: string;
  let app: Hono;
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const url = "/api/projects/asset/photo.png?path=projects/photo.png";

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "rome-asset-cache-"));
    writeFileSync(join(rootDir, "photo.png"), image);
    app = new Hono();
    app.get(
      "/api/projects/asset/:fileName",
      createAssetHandler({
        assetBasePath: "/api/projects/asset",
        logicalRoot: "projects",
        rootDir,
      }),
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it.each([
    ["the current ETag", (etag: string): string => etag],
    [
      "a list containing the current ETag",
      (etag: string): string => `"stale", ${etag} , W/"other"`,
    ],
    ["a wildcard", (_etag: string): string => "*"],
    ["the current ETag without W/", (etag: string): string => etag.slice(2)],
  ] as const)("returns an empty 304 for %s", async (_case, header) => {
    const initial = await app.request(url);
    const etag = initial.headers.get("ETag")!;
    expect(Buffer.from(await initial.arrayBuffer())).toEqual(image);

    const response = await app.request(url, { headers: { "If-None-Match": header(etag) } });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

  it.each([
    'W/"stale"',
    '"stale", W/"other"',
  ])("returns the full image with validators for a mismatched If-None-Match %s", async (header) => {
    const response = await app.request(url, { headers: { "If-None-Match": header } });
    const { mtimeMs, size } = statSync(join(rootDir, "photo.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(`W/"${Math.trunc(mtimeMs)}-${size}"`);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
  });

  it("changes the ETag when an overwrite changes mtime but keeps the same size", async () => {
    const initial = await app.request(url);
    const etag = initial.headers.get("ETag")!;
    await initial.arrayBuffer();
    const filePath = join(rootDir, "photo.png");
    const { mtimeMs } = statSync(filePath);
    const replacement = Buffer.from([0x89, 0x50, 0x4e, 0x48]);
    writeFileSync(filePath, replacement);
    const modified = new Date(mtimeMs + 2000);
    utimesSync(filePath, modified, modified);

    const response = await app.request(url, { headers: { "If-None-Match": etag } });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).not.toBe(etag);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(replacement);
  });
});

describe("createResolveHandler", () => {
  let rootDir = "";
  let scope: FileBrowserScope;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "rome-resolve-"));
    scope = { assetBasePath: "/api/projects/asset", logicalRoot: "projects", rootDir };
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const callResolve = async (path: string | null): Promise<{ status: number; body: unknown }> => {
    const app = new Hono();
    app.get("/projects/resolve", createResolveHandler(scope));
    const url =
      path === null
        ? "http://localhost/projects/resolve"
        : `http://localhost/projects/resolve?path=${encodeURIComponent(path)}`;
    const response = await app.request(url);
    return { status: response.status, body: await response.json() };
  };

  it("returns file metadata without content for a text file", async () => {
    writeFileSync(join(rootDir, "notes.md"), "hello", "utf-8");
    const { status, body } = await callResolve("projects/notes.md");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      type: "file",
      path: "projects/notes.md",
      kind: "text",
      editable: true,
      assetUrl: null,
      size: 5,
    });
    expect(body).not.toHaveProperty("content");
  });

  it("returns an assetUrl for a non-text file", async () => {
    writeFileSync(join(rootDir, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { status, body } = await callResolve("projects/photo.png");
    expect(status).toBe(200);
    expect(body).toMatchObject({ type: "file", kind: "image", editable: false });
    expect((body as { assetUrl: string }).assetUrl).toMatch(/^\/api\/projects\/asset\//);
  });

  it("returns directory for a folder", async () => {
    mkdirSync(join(rootDir, "sub"));
    const { status, body } = await callResolve("projects/sub");
    expect(status).toBe(200);
    expect(body).toEqual({ type: "directory", path: "projects/sub" });
  });

  it("returns the logical root as a directory", async () => {
    const { status, body } = await callResolve("projects");
    expect(status).toBe(200);
    expect(body).toEqual({ type: "directory", path: "projects" });
  });

  it("returns missing for a path that does not exist", async () => {
    const { status, body } = await callResolve("projects/ghost.md");
    expect(status).toBe(200);
    expect(body).toEqual({ type: "missing", path: "projects/ghost.md" });
  });

  it("rejects a missing path parameter with 400", async () => {
    const { status, body } = await callResolve(null);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: expect.any(String) });
  });

  it("rejects paths outside the scope with 400", async () => {
    const { status, body } = await callResolve("../escape.txt");
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "Invalid path" });
  });

  it("rejects paths under a different logical root with 400", async () => {
    const { status, body } = await callResolve("memory/notes.md");
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "Invalid path" });
  });
});

describe("confineToRealRoot", () => {
  let rootDir = "";
  let outsideDir = "";

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "rome-confine-root-"));
    outsideDir = mkdtempSync(join(tmpdir(), "rome-confine-outside-"));
    writeFileSync(join(outsideDir, "notes.md"), "outside");
    symlinkSync(outsideDir, join(rootDir, "link"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  const getFile = async (scope: FileBrowserScope, path: string) => {
    const app = new Hono();
    app.get("/projects/file", createFileGetHandler(scope));
    const response = await app.request(
      `http://localhost/projects/file?path=${encodeURIComponent(path)}`,
    );
    return { status: response.status, body: await response.json() };
  };

  it("leaves an owner scope free to follow a symlink out of the root", async () => {
    const { status, body } = await getFile(
      { assetBasePath: "/api/projects/asset", logicalRoot: "projects", rootDir },
      "projects/link/notes.md",
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ content: "outside" });
  });

  it("rejects the same symlink on a confined scope", async () => {
    const { status, body } = await getFile(
      {
        assetBasePath: "/api/projects/asset",
        confineToRealRoot: true,
        logicalRoot: "projects",
        rootDir,
      },
      "projects/link/notes.md",
    );
    expect(status).toBe(400);
    expect(body).toEqual({ error: "Invalid path" });
  });
});

describe("file browser asset width", () => {
  let rootDir: string;
  let app: Hono;
  let png: Buffer;
  const url = (name: string, query = "") =>
    `/api/projects/asset/${name}?path=projects/${name}${query}`;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "rome-asset-width-"));
    // Noise does not compress, so the PNG is large and its WebP is much smaller.
    png = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: "#808080",
        noise: { type: "gaussian", mean: 128, sigma: 30 },
      },
    })
      .png()
      .toBuffer();
    writeFileSync(join(rootDir, "photo.png"), png);
    app = new Hono();
    app.get(
      "/api/projects/asset/:fileName",
      createAssetHandler({
        assetBasePath: "/api/projects/asset",
        logicalRoot: "projects",
        rootDir,
      }),
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  async function bytes(response: Response): Promise<Buffer> {
    return Buffer.from(await response.arrayBuffer());
  }

  it.each([
    [600, 600, 400],
    [900, 900, 600],
  ])("serves a WebP no longer than w=%s on its long edge", async (w, width, height) => {
    const response = await app.request(url("photo.png", `&w=${w}`));
    const body = await bytes(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    const { mtimeMs, size } = statSync(join(rootDir, "photo.png"));
    expect(response.headers.get("ETag")).toBe(`W/"${Math.trunc(mtimeMs)}-${size}-w${w}"`);
    expect(body.length).toBeLessThan(size);
    const meta = await sharp(body).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", width, height]);
  });

  it("does not enlarge a picture narrower than the width", async () => {
    const small = await sharp(png).resize(300).png().toBuffer();
    writeFileSync(join(rootDir, "small.png"), small);
    const response = await app.request(url("small.png", "&w=900"));
    const meta = await sharp(await bytes(response)).metadata();
    expect([response.headers.get("Content-Type"), meta.width]).toEqual(["image/webp", 300]);
  });

  it("resizes JPEG and WebP pictures too", async () => {
    writeFileSync(join(rootDir, "photo.jpg"), await sharp(png).jpeg({ quality: 95 }).toBuffer());
    writeFileSync(join(rootDir, "photo.webp"), await sharp(png).webp({ quality: 100 }).toBuffer());
    for (const name of ["photo.jpg", "photo.webp"]) {
      const response = await app.request(url(name, "&w=600"));
      const meta = await sharp(await bytes(response)).metadata();
      expect([name, meta.format, meta.width]).toEqual([name, "webp", 600]);
    }
  });

  it("returns 304 for the width ETag without decoding the picture", async () => {
    // A whole-second mtime survives the round trip through a Date exactly.
    const filePath = join(rootDir, "photo.png");
    const mtime = new Date(1_700_000_000_000);
    utimesSync(filePath, mtime, mtime);
    const first = await app.request(url("photo.png", "&w=900"));
    const etag = first.headers.get("ETag")!;
    await first.arrayBuffer();
    // The same size and mtime, but bytes that no decoder reads: only a 304
    // that skips the decoder can answer without falling back to the original.
    writeFileSync(filePath, Buffer.alloc(png.length, 1));
    utimesSync(filePath, mtime, mtime);

    const response = await app.request(url("photo.png", "&w=900"), {
      headers: { "If-None-Match": etag },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.body).toBeNull();
  });

  it("does not let an original's ETag validate a width, or the reverse", async () => {
    const original = await app.request(url("photo.png"));
    const resized = await app.request(url("photo.png", "&w=900"));
    expect(original.headers.get("ETag")).not.toBe(resized.headers.get("ETag"));
    const other = await app.request(url("photo.png", "&w=600"), {
      headers: { "If-None-Match": resized.headers.get("ETag")! },
    });
    expect(other.status).toBe(200);
    const plain = await app.request(url("photo.png"), {
      headers: { "If-None-Match": resized.headers.get("ETag")! },
    });
    expect(plain.status).toBe(200);
  });

  it("changes the width ETag and the bytes when an overwrite keeps the same size", async () => {
    // Bytes after the PNG's last chunk are ignored by the decoder, so padding
    // gives two different pictures one file size.
    const other = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: "#206090" },
    })
      .png()
      .toBuffer();
    const total = png.length + 10_000;
    const filePath = join(rootDir, "photo.png");
    writeFileSync(filePath, Buffer.concat([png, Buffer.alloc(total - png.length)]));
    const first = await app.request(url("photo.png", "&w=900"));
    const etag = first.headers.get("ETag")!;
    const before = await bytes(first);
    const { mtimeMs } = statSync(filePath);
    writeFileSync(filePath, Buffer.concat([other, Buffer.alloc(total - other.length)]));
    utimesSync(filePath, new Date(mtimeMs + 2000), new Date(mtimeMs + 2000));

    const response = await app.request(url("photo.png", "&w=900"), {
      headers: { "If-None-Match": etag },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).not.toBe(etag);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(await bytes(response)).not.toEqual(before);
  });

  it.each([
    "601",
    "abc",
    "",
    "0",
    "-900",
    "900.5",
    "900px",
  ])("serves the original for w=%j", async (w) => {
    const response = await app.request(url("photo.png", `&w=${w}`));
    const { mtimeMs, size } = statSync(join(rootDir, "photo.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("ETag")).toBe(`W/"${Math.trunc(mtimeMs)}-${size}"`);
    expect(await bytes(response)).toEqual(png);
  });

  it("serves the original for a GIF, an SVG and an animated WebP", async () => {
    const frame = await sharp(png).resize(40, 40).png().toBuffer();
    const inverse = await sharp(png).resize(40, 40).negate().png().toBuffer();
    const animated = await sharp([frame, inverse], { join: { animated: true } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    const files: Array<[string, Buffer, string]> = [
      ["still.gif", Buffer.from("GIF89a-not-decoded"), "image/gif"],
      ["vector.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"],
      ["moving.webp", animated, "image/webp"],
    ];
    for (const [name, content, type] of files) {
      writeFileSync(join(rootDir, name), content);
      const response = await app.request(url(name, "&w=600"));
      expect([name, response.status, response.headers.get("Content-Type")]).toEqual([
        name,
        200,
        type,
      ]);
      expect([name, await bytes(response)]).toEqual([name, content]);
    }
  });

  it("serves the original with its plain ETag when the picture cannot be decoded", async () => {
    const corrupt = Buffer.from("this is not a png at all");
    writeFileSync(join(rootDir, "broken.png"), corrupt);
    const response = await app.request(url("broken.png", "&w=900"));
    const { mtimeMs, size } = statSync(join(rootDir, "broken.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("ETag")).toBe(`W/"${Math.trunc(mtimeMs)}-${size}"`);
    expect(await bytes(response)).toEqual(corrupt);
  });

  it("serves the original under the width ETag when the WebP is not smaller", async () => {
    const raw = Buffer.alloc(16 * 16 * 3);
    for (let i = 0; i < 256; i++) {
      raw.fill(((i % 16) + Math.floor(i / 16)) % 2 ? 255 : 0, i * 3, i * 3 + 3);
    }
    const tiny = await sharp(raw, { raw: { width: 16, height: 16, channels: 3 } })
      .png({ palette: true, colours: 2 })
      .toBuffer();
    writeFileSync(join(rootDir, "tiny.png"), tiny);
    const response = await app.request(url("tiny.png", "&w=600"));
    const { mtimeMs, size } = statSync(join(rootDir, "tiny.png"));
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("ETag")).toBe(`W/"${Math.trunc(mtimeMs)}-${size}-w600"`);
    expect(await bytes(response)).toEqual(tiny);
  });

  it("leaves a request without w unchanged", async () => {
    const response = await app.request(url("photo.png"));
    const { mtimeMs, size } = statSync(join(rootDir, "photo.png"));
    expect(Object.fromEntries(response.headers)).toEqual({
      "accept-ranges": "bytes",
      "cache-control": "private, no-cache",
      "content-disposition": expect.stringContaining("photo.png"),
      "content-length": String(size),
      "content-type": "image/png",
      etag: `W/"${Math.trunc(mtimeMs)}-${size}"`,
    });
    expect(await bytes(response)).toEqual(png);
  });
});
