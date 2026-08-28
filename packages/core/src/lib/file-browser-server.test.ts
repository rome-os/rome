import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
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
