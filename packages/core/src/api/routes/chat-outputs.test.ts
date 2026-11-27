import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatOutputsResponse } from "@rome/api-types/chat-outputs";
import { createTestDb, type TestDb } from "../../test/db.js";
import { ChatsWebChatRepository } from "../../webchat/chats-webchat-repository.js";
import { chatOutputsRoutes, rangeOf } from "./chat-outputs.js";

describe("chat outputs content route", () => {
  let testDb: TestDb;
  let root: string;
  let saved: string | undefined;
  let app: ReturnType<typeof chatOutputsRoutes>;
  let contentUrl: string;

  beforeEach(async () => {
    testDb = createTestDb();
    root = mkdtempSync(join(tmpdir(), "rome-chat-outputs-route-test-"));
    const projects = join(root, "projects");
    mkdirSync(join(projects, "demo"), { recursive: true });
    saved = process.env.ROME_PROJECTS_ROOT;
    process.env.ROME_PROJECTS_ROOT = projects;
    const chats = new ChatsWebChatRepository(testDb.db);
    await chats.createSession("chat-1", "Chat");
    const clip = join(projects, "demo", "clip.mp4");
    writeFileSync(clip, "0123456789");
    await chats.appendTraceBlocks({
      messageId: "t1-trace",
      sessionId: "chat-1",
      turnId: "t1",
      startSeq: 0,
      blocks: [
        { type: "turn_start", turnId: "t1" },
        { type: "tool_use", id: "u1", tool: "Write", input: { file_path: clip } },
        { type: "tool_result", toolUseId: "u1", tool: "Write", output: "ok" },
      ],
    });
    app = chatOutputsRoutes({ db: testDb.db, webchatRepo: chats, concierge: undefined } as never);
    const listed = (await (
      await app.request("/chat/sessions/chat-1/outputs")
    ).json()) as ChatOutputsResponse;
    expect(listed.outputs[0]).toMatchObject({ name: "clip.mp4", fileKind: "video" });
    contentUrl = (listed.outputs[0]?.contentUrl ?? "").replace(/^\/api/, "");
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ROME_PROJECTS_ROOT;
    else process.env.ROME_PROJECTS_ROOT = saved;
    testDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the whole file and says it takes ranges", async () => {
    const response = await app.request(contentUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(await response.text()).toBe("0123456789");
  });

  it("serves the part a player asks for", async () => {
    const response = await app.request(contentUrl, { headers: { Range: "bytes=2-5" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(await response.text()).toBe("2345");
  });

  it("serves the whole file for several ranges or a malformed one", async () => {
    for (const range of ["bytes=0-1,4-5", "bytes=5-2", "items=0-1"]) {
      const response = await app.request(contentUrl, { headers: { Range: range } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("0123456789");
    }
  });

  it("refuses a range past the end", async () => {
    const response = await app.request(contentUrl, { headers: { Range: "bytes=20-" } });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
  });
});

describe("rangeOf", () => {
  it("reads one range, a suffix and an open end", () => {
    expect(rangeOf("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(rangeOf("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(rangeOf("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(rangeOf("bytes=10-", 10)).toBe("unsatisfiable");
    expect(rangeOf("bytes=0-1,4-5", 10)).toBeNull();
    expect(rangeOf(undefined, 10)).toBeNull();
  });
});
