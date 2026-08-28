import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as childProcessModule from "node:child_process" with { rstest: "importActual" };
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import * as pathsModule from "../../paths.js" with { rstest: "importActual" };

const childProcessState = rs.hoisted(() => ({
  execFileSync: rs.fn(),
}));

const chokidarState = rs.hoisted(() => ({
  watchers: [] as Array<{
    close: ReturnType<typeof rs.fn>;
    emit: (eventName: string, ...args: unknown[]) => boolean;
  }>,
}));

rs.mock("node:child_process", () => ({
  ...childProcessModule,
  default: childProcessModule,
  execFileSync: childProcessState.execFileSync,
}));

rs.mock("chokidar", () => {
  return {
    watch: rs.fn(() => {
      const watcher = Object.assign(new EventEmitter(), {
        close: rs.fn(async () => undefined),
      });
      chokidarState.watchers.push(watcher);
      return watcher;
    }),
  };
});

const state = rs.hoisted(() => ({
  profileDir: "",
  memoryDir: "",
}));

rs.mock("../../paths.js", () => ({
  ...pathsModule,
  getProfileDir: rs.fn(() => state.profileDir),
}));

rs.mock("../../profile-memory.js", () => ({
  ensureProfileMemoryInitialized: rs.fn(() => state.memoryDir),
}));

import { memoryFilesRoutes } from "./memory-files.js";

function buildApp() {
  return new Hono().route("/", memoryFilesRoutes());
}

async function readTarGzEntries(res: Response): Promise<Record<string, string>> {
  const archive = gunzipSync(Buffer.from(await res.arrayBuffer()));
  const entries: Record<string, string> = {};
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf-8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const path = prefix ? `${prefix}/${name}` : name;

    offset += 512;
    entries[path] = archive.subarray(offset, offset + size).toString("utf-8");
    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

describe("Memory files API", () => {
  beforeEach(() => {
    state.profileDir = mkdtempSync(join(tmpdir(), "rome-memory-file-route-"));
    state.memoryDir = join(state.profileDir, "memory");
    mkdirSync(state.memoryDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(state.profileDir, { recursive: true, force: true });
    rs.clearAllMocks();
    chokidarState.watchers = [];
  });

  describe("GET /memory/tree", () => {
    it("loads only two layers by default", async () => {
      mkdirSync(join(state.memoryDir, "journal", "2026", "05"), { recursive: true });
      mkdirSync(join(state.memoryDir, ".drafts"), { recursive: true });
      writeFileSync(join(state.memoryDir, ".notes.md"), "hidden\n");
      writeFileSync(join(state.memoryDir, ".drafts", "private.md"), "hidden\n");
      writeFileSync(join(state.memoryDir, "journal", "2026", "05", "11.md"), "entry\n");

      const res = await buildApp().request("/memory/tree");

      expect(res.status).toBe(200);
      const tree = (await res.json()) as Array<{
        children?: Array<{ children?: unknown[]; name: string; type: string }>;
        name: string;
        type: string;
      }>;
      const journal = tree.find((node) => node.name === "journal");
      expect(journal).toMatchObject({ name: "journal", type: "directory" });
      expect(tree.map((node) => node.name)).toEqual(["journal"]);
      const year = journal?.children?.find((node) => node.name === "2026");
      expect(year).toMatchObject({ name: "2026", type: "directory" });
      expect(year).not.toHaveProperty("children");
    });

    it("loads a requested folder one layer at a time", async () => {
      mkdirSync(join(state.memoryDir, "journal", "2026", "05"), { recursive: true });
      writeFileSync(join(state.memoryDir, "journal", "2026", "05", "11.md"), "entry\n");

      const res = await buildApp().request("/memory/tree?path=memory/journal/2026&depth=1");

      expect(res.status).toBe(200);
      const children = (await res.json()) as Array<{ children?: unknown[]; name: string }>;
      expect(children).toMatchObject([
        {
          name: "05",
          path: "memory/journal/2026/05",
          type: "directory",
        },
      ]);
      expect(children[0]).not.toHaveProperty("children");
    });
  });

  describe("GET /memory/search", () => {
    it("matches literal search terms that contain regex characters", async () => {
      writeFileSync(join(state.memoryDir, "MEMORY.md"), "We work on C++ tooling.\n");
      childProcessState.execFileSync.mockReturnValue("./MEMORY.md:1:We work on C++ tooling.\n");

      const res = await buildApp().request("/memory/search?q=C%2B%2B");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual([
        {
          content: "We work on C++ tooling.",
          file: "memory/MEMORY.md",
          line: 1,
        },
      ]);
      expect(childProcessState.execFileSync).toHaveBeenCalledTimes(1);
      expect(childProcessState.execFileSync).toHaveBeenCalledWith(
        "rg",
        expect.arrayContaining(["--fixed-strings", "C++", "."]),
        expect.any(Object),
      );
    });
  });

  it("returns editable text content for markdown files", async () => {
    writeFileSync(join(state.memoryDir, "IDENTITY.md"), "# Identity\n");

    const res = await buildApp().request("/memory/file?path=memory/IDENTITY.md");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      path: "memory/IDENTITY.md",
      kind: "text",
      editable: true,
      mimeType: "text/markdown",
      content: "# Identity\n",
      assetUrl: null,
    });
  });

  it("closes the events stream when the watcher fails before ready", async () => {
    const responsePromise = buildApp().request("/memory/events");

    await rs.waitFor(() => {
      expect(chokidarState.watchers).toHaveLength(1);
    });

    chokidarState.watchers[0].emit("error", new Error("ENOSPC"));

    const res = await responsePromise;
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("");
    expect(chokidarState.watchers[0].close).toHaveBeenCalledTimes(1);
  });

  it("rejects folder paths for file reads", async () => {
    mkdirSync(join(state.memoryDir, "folder"), { recursive: true });

    const res = await buildApp().request("/memory/file?path=memory/folder");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Path must be a file" });
  });

  it("returns a previewable asset for PDF files", async () => {
    writeFileSync(join(state.memoryDir, "guide.pdf"), "%PDF-1.4\n");

    const res = await buildApp().request("/memory/file?path=memory/guide.pdf");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      path: "memory/guide.pdf",
      kind: "pdf",
      editable: false,
      mimeType: "application/pdf",
      content: null,
    });
    expect(data.assetUrl).toMatch(
      /^\/api\/memory\/asset\/guide\.pdf\?path=memory%2Fguide\.pdf&v=\d+-9$/,
    );
  });

  it("returns a previewable asset for DOCX files", async () => {
    writeFileSync(join(state.memoryDir, "guide.docx"), "docx-bytes");

    const res = await buildApp().request("/memory/file?path=memory/guide.docx");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      path: "memory/guide.docx",
      kind: "docx",
      editable: false,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: null,
    });
    expect(data.assetUrl).toMatch(
      /^\/api\/memory\/asset\/guide\.docx\?path=memory%2Fguide\.docx&v=\d+-10$/,
    );
  });

  it("returns editable HTML content with a previewable asset", async () => {
    writeFileSync(join(state.memoryDir, "page.html"), "<h1>Hello</h1>\n");

    const res = await buildApp().request("/memory/file?path=memory/page.html");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      path: "memory/page.html",
      kind: "text",
      editable: true,
      mimeType: "text/html",
      content: "<h1>Hello</h1>\n",
    });
    expect(data.assetUrl).toMatch(
      /^\/api\/memory\/asset\/page\.html\?path=memory%2Fpage\.html&v=\d+-15$/,
    );
  });

  it("serves HTML assets inline for previews", async () => {
    writeFileSync(join(state.memoryDir, "page.html"), "<h1>Hello</h1>\n");

    const res = await buildApp().request("/memory/asset/page.html?path=memory/page.html");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename=\"page.html\"; filename*=UTF-8''page.html",
    );
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<h1>Hello</h1>\n");
  });

  it("serves PDF assets inline with range support", async () => {
    writeFileSync(join(state.memoryDir, "guide.pdf"), "%PDF-1.4\n");

    const res = await buildApp().request("/memory/asset/guide.pdf?path=memory/guide.pdf", {
      headers: { range: "bytes=0-3" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename=\"guide.pdf\"; filename*=UTF-8''guide.pdf",
    );
    expect(res.headers.get("content-range")).toBe("bytes 0-3/9");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(await res.text()).toBe("%PDF");
  });

  it("serves DOCX assets inline with range support", async () => {
    writeFileSync(join(state.memoryDir, "guide.docx"), "docx-bytes");

    const res = await buildApp().request("/memory/asset/guide.docx?path=memory/guide.docx", {
      headers: { range: "bytes=0-3" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename=\"guide.docx\"; filename*=UTF-8''guide.docx",
    );
    expect(res.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(await res.text()).toBe("docx");
  });

  it("returns a previewable asset for audio files", async () => {
    writeFileSync(join(state.memoryDir, "note.mp3"), "audio-bytes");

    const res = await buildApp().request("/memory/file?path=memory/note.mp3");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      path: "memory/note.mp3",
      kind: "audio",
      editable: false,
      mimeType: "audio/mpeg",
      content: null,
    });
    expect(data.assetUrl).toMatch(
      /^\/api\/memory\/asset\/note\.mp3\?path=memory%2Fnote\.mp3&v=\d+-11$/,
    );
  });

  it("serves audio assets inline with range support", async () => {
    writeFileSync(join(state.memoryDir, "note.mp3"), "audio-bytes");

    const res = await buildApp().request("/memory/asset/note.mp3?path=memory/note.mp3", {
      headers: { range: "bytes=0-4" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename=\"note.mp3\"; filename*=UTF-8''note.mp3",
    );
    expect(res.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(await res.text()).toBe("audio");
  });

  it("rejects writes to media files", async () => {
    const res = await buildApp().request("/memory/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "memory/gallery/clip.mp4",
        content: "not-a-video",
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Only text memory files can be edited",
    });
  });

  it("can save text files without creating a git commit", async () => {
    mkdirSync(join(state.memoryDir, ".git"), { recursive: true });
    writeFileSync(join(state.memoryDir, "MEMORY.md"), "old\n");

    const res = await buildApp().request("/memory/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "memory/MEMORY.md",
        content: "new\n",
        commit: false,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      message: "Saved",
      success: true,
    });
    expect(readFileSync(join(state.memoryDir, "MEMORY.md"), "utf-8")).toBe("new\n");
    expect(childProcessState.execFileSync).not.toHaveBeenCalled();
  });

  it("keeps git commits enabled for ordinary text saves", async () => {
    mkdirSync(join(state.memoryDir, ".git"), { recursive: true });
    writeFileSync(join(state.memoryDir, "MEMORY.md"), "old\n");
    childProcessState.execFileSync.mockReturnValue("");

    const res = await buildApp().request("/memory/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "memory/MEMORY.md",
        content: "new\n",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      message: "Saved and committed",
      success: true,
    });
    expect(childProcessState.execFileSync).toHaveBeenCalledWith(
      "git",
      ["add", "--", "MEMORY.md"],
      expect.any(Object),
    );
    expect(childProcessState.execFileSync).toHaveBeenCalledWith(
      "git",
      ["commit", "-m", "memory: update MEMORY.md"],
      expect.any(Object),
    );
  });

  it("reports manual save failures when the git commit fails", async () => {
    mkdirSync(join(state.memoryDir, ".git"), { recursive: true });
    writeFileSync(join(state.memoryDir, "MEMORY.md"), "old\n");
    childProcessState.execFileSync.mockImplementation((_command, args) => {
      if (Array.isArray(args) && args[0] === "commit") {
        throw new Error("commit failed");
      }
      return "";
    });

    const res = await buildApp().request("/memory/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "memory/MEMORY.md",
        content: "new\n",
      }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "Saved to disk, but failed to create git commit",
    });
    expect(readFileSync(join(state.memoryDir, "MEMORY.md"), "utf-8")).toBe("new\n");
    expect(childProcessState.execFileSync).toHaveBeenCalledTimes(2);
  });

  describe("GET /memory/download", () => {
    it("downloads a file as an attachment", async () => {
      writeFileSync(join(state.memoryDir, "IDENTITY.md"), "# Identity\n");

      const res = await buildApp().request("/memory/download?path=memory/IDENTITY.md");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("content-disposition")).toContain("IDENTITY.md");
      expect(await res.text()).toBe("# Identity\n");
    });

    it("downloads a folder as a compressed archive", async () => {
      mkdirSync(join(state.memoryDir, "journal", "2026"), { recursive: true });
      mkdirSync(join(state.memoryDir, "journal", ".drafts"), { recursive: true });
      writeFileSync(join(state.memoryDir, "journal", "2026", "04.md"), "entry\n");
      writeFileSync(join(state.memoryDir, "journal", ".drafts", "private.md"), "hidden\n");
      writeFileSync(join(state.memoryDir, "journal", ".secret.md"), "hidden\n");

      const res = await buildApp().request("/memory/download?path=memory/journal");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/gzip");
      expect(res.headers.get("content-disposition")).toContain("journal.tar.gz");
      await expect(readTarGzEntries(res)).resolves.toEqual({
        "journal/": "",
        "journal/2026/": "",
        "journal/2026/04.md": "entry\n",
      });
    });

    it("downloads multiple selected paths as one compressed archive", async () => {
      mkdirSync(join(state.memoryDir, "journal"), { recursive: true });
      writeFileSync(join(state.memoryDir, "IDENTITY.md"), "# Identity\n");
      writeFileSync(join(state.memoryDir, "journal", "04.md"), "entry\n");

      const res = await buildApp().request(
        "/memory/download?path=memory/IDENTITY.md&path=memory/journal",
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/gzip");
      expect(res.headers.get("content-disposition")).toContain("memory-selection.tar.gz");
      await expect(readTarGzEntries(res)).resolves.toEqual({
        "IDENTITY.md": "# Identity\n",
        "journal/": "",
        "journal/04.md": "entry\n",
      });
    });
  });

  describe("POST /memory/file", () => {
    it("creates a new memory text file", async () => {
      const res = await buildApp().request("/memory/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/notes.md", type: "file" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Created file",
        path: "memory/notes.md",
        success: true,
      });
      expect(readFileSync(join(state.memoryDir, "notes.md"), "utf-8")).toBe("");
    });

    it("creates a new memory folder", async () => {
      const res = await buildApp().request("/memory/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/journal", type: "folder" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Created folder",
        path: "memory/journal",
        success: true,
      });
      expect(existsSync(join(state.memoryDir, "journal"))).toBe(true);
    });

    it("rejects create conflicts", async () => {
      writeFileSync(join(state.memoryDir, "notes.md"), "existing");

      const res = await buildApp().request("/memory/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/notes.md", type: "file" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: "A file or folder with that name already exists",
      });
      expect(readFileSync(join(state.memoryDir, "notes.md"), "utf-8")).toBe("existing");
    });

    it("rejects creating binary memory files", async () => {
      const res = await buildApp().request("/memory/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/photo.png", type: "file" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Only text memory files can be created",
      });
      expect(existsSync(join(state.memoryDir, "photo.png"))).toBe(false);
    });

    it("uploads dragged files into the requested memory directory", async () => {
      mkdirSync(join(state.memoryDir, "gallery"), { recursive: true });
      const formData = new FormData();
      formData.append("path", "memory/gallery");
      formData.append("files", new File(["photo-bytes"], "photo.png", { type: "image/png" }));

      const res = await buildApp().request("/memory/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        files: [{ path: "memory/gallery/photo.png", size: 11 }],
        message: "Uploaded 1 file",
        success: true,
      });
      expect(readFileSync(join(state.memoryDir, "gallery", "photo.png"), "utf-8")).toBe(
        "photo-bytes",
      );
    });

    it("uploads folder contents with nested relative paths", async () => {
      const formData = new FormData();
      formData.append("path", "memory");
      formData.append("files", new File(["daily"], "10.md", { type: "text/markdown" }));
      formData.append("paths", "journal/2026/06/10.md");
      formData.append("files", new File(["notes"], "notes.md", { type: "text/markdown" }));
      formData.append("paths", "projects/rome/notes.md");

      const res = await buildApp().request("/memory/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        files: [
          { path: "memory/journal/2026/06/10.md", size: 5 },
          { path: "memory/projects/rome/notes.md", size: 5 },
        ],
        message: "Uploaded 2 files",
        success: true,
      });
      expect(readFileSync(join(state.memoryDir, "journal", "2026", "06", "10.md"), "utf-8")).toBe(
        "daily",
      );
      expect(readFileSync(join(state.memoryDir, "projects", "rome", "notes.md"), "utf-8")).toBe(
        "notes",
      );
    });

    it("creates the target directory when it does not exist", async () => {
      const formData = new FormData();
      formData.append("path", "memory/new-folder");
      formData.append("files", new File(["hello"], "note.txt", { type: "text/plain" }));

      const res = await buildApp().request("/memory/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(200);
      expect(readFileSync(join(state.memoryDir, "new-folder", "note.txt"), "utf-8")).toBe("hello");
    });

    it("rejects paths outside the scoped root", async () => {
      const formData = new FormData();
      formData.append("path", "not-memory/attack");
      formData.append("files", new File(["x"], "x.txt"));

      const res = await buildApp().request("/memory/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "Invalid path" });
    });

    it("returns 400 when no files are attached", async () => {
      const formData = new FormData();
      formData.append("path", "memory");

      const res = await buildApp().request("/memory/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "At least one file is required",
      });
    });

    it("rejects uploads whose target is a regular file", async () => {
      writeFileSync(join(state.memoryDir, "taken.md"), "claimed");
      const formData = new FormData();
      formData.append("path", "memory/taken.md");
      formData.append("files", new File(["x"], "x.txt"));

      const res = await buildApp().request("/memory/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Upload target must be a directory",
      });
    });
  });

  describe("PATCH /memory/file", () => {
    it("renames memory files", async () => {
      writeFileSync(join(state.memoryDir, "old.md"), "note");

      const res = await buildApp().request("/memory/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/old.md", name: "new.md" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Renamed file",
        path: "memory/new.md",
        success: true,
      });
      expect(existsSync(join(state.memoryDir, "old.md"))).toBe(false);
      expect(readFileSync(join(state.memoryDir, "new.md"), "utf-8")).toBe("note");
    });

    it("renames memory folders", async () => {
      mkdirSync(join(state.memoryDir, "journal"), { recursive: true });
      writeFileSync(join(state.memoryDir, "journal", "entry.md"), "entry");

      const res = await buildApp().request("/memory/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/journal", name: "archive" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Renamed folder",
        path: "memory/archive",
        success: true,
      });
      expect(existsSync(join(state.memoryDir, "journal"))).toBe(false);
      expect(readFileSync(join(state.memoryDir, "archive", "entry.md"), "utf-8")).toBe("entry");
    });

    it("moves memory files into folders", async () => {
      mkdirSync(join(state.memoryDir, "archive"), { recursive: true });
      writeFileSync(join(state.memoryDir, "note.md"), "note");

      const res = await buildApp().request("/memory/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/note.md", parentPath: "memory/archive" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Moved file",
        path: "memory/archive/note.md",
        success: true,
      });
      expect(existsSync(join(state.memoryDir, "note.md"))).toBe(false);
      expect(readFileSync(join(state.memoryDir, "archive", "note.md"), "utf-8")).toBe("note");
    });

    it("rejects moving folders into themselves", async () => {
      mkdirSync(join(state.memoryDir, "journal", "2026"), { recursive: true });

      const res = await buildApp().request("/memory/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/journal", parentPath: "memory/journal/2026" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Cannot move a folder into itself",
      });
      expect(existsSync(join(state.memoryDir, "journal", "2026"))).toBe(true);
    });

    it("rejects renaming the memory root", async () => {
      const res = await buildApp().request("/memory/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory", name: "renamed" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Cannot rename memory root",
      });
      expect(existsSync(state.memoryDir)).toBe(true);
    });

    it("rejects rename conflicts", async () => {
      writeFileSync(join(state.memoryDir, "old.md"), "old");
      writeFileSync(join(state.memoryDir, "new.md"), "new");

      const res = await buildApp().request("/memory/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/old.md", name: "new.md" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: "A file or folder with that name already exists",
      });
      expect(readFileSync(join(state.memoryDir, "old.md"), "utf-8")).toBe("old");
      expect(readFileSync(join(state.memoryDir, "new.md"), "utf-8")).toBe("new");
    });

    it("rejects nested rename names", async () => {
      writeFileSync(join(state.memoryDir, "old.md"), "old");

      const res = await buildApp().request("/memory/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "memory/old.md", name: "../new.md" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Name must be a single file or folder name",
      });
      expect(existsSync(join(state.memoryDir, "old.md"))).toBe(true);
    });
  });

  describe("DELETE /memory/file", () => {
    it("deletes memory files", async () => {
      writeFileSync(join(state.memoryDir, "stale.md"), "old");

      const res = await buildApp().request("/memory/file?path=memory/stale.md", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Deleted file",
        success: true,
      });
      expect(existsSync(join(state.memoryDir, "stale.md"))).toBe(false);
    });

    it("deletes memory folders recursively", async () => {
      mkdirSync(join(state.memoryDir, "journal", "2026"), { recursive: true });
      writeFileSync(join(state.memoryDir, "journal", "2026", "04.md"), "entry");

      const res = await buildApp().request("/memory/file?path=memory/journal", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Deleted folder",
        success: true,
      });
      expect(existsSync(join(state.memoryDir, "journal"))).toBe(false);
    });

    it("rejects deleting the memory root", async () => {
      const res = await buildApp().request("/memory/file?path=memory", {
        method: "DELETE",
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Cannot delete memory root",
      });
      expect(existsSync(state.memoryDir)).toBe(true);
    });
  });
});
