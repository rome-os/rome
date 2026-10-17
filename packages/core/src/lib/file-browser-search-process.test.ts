import { afterEach, describe, expect, it, rs } from "@rstest/core";
import * as childProcessModule from "node:child_process" with { rstest: "importActual" };
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { Hono } from "hono";
import { createSearchHandler } from "./file-browser-server.js";

const state = rs.hoisted(() => ({ spawn: rs.fn(), logError: rs.fn() }));
rs.mock("node:child_process", () => ({ ...childProcessModule, spawn: state.spawn }));
rs.mock("../logger.js", () => ({ createLogger: () => ({ error: state.logError }) }));

afterEach(() => {
  rs.resetAllMocks();
});

// Only the subprocess and logging edges are faked. PassThrough exercises Node's
// actual UTF-8 decoder, while explicit close events make exit ordering observable.
async function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: rs.fn(() => true),
  });
  state.spawn.mockReturnValue(child);
  const app = new Hono().get(
    "/search",
    createSearchHandler({ assetBasePath: "/asset", logicalRoot: "projects", rootDir: "/unused" }),
  );
  const response = Promise.resolve(app.request("/search?q=match"));
  await rs.waitFor(() => expect(state.spawn).toHaveBeenCalledTimes(1));
  const close = async (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.stdout.end();
    child.stderr.end();
    await Promise.all([finished(child.stdout), finished(child.stderr)]);
    child.emit("close", code, signal);
  };
  return { child, response, close };
}

function matches(count: number): string {
  return Array.from({ length: count }, (_, index) => `./notes.txt:${index + 1}:match\n`).join("");
}

describe("file search subprocess output", () => {
  it("decodes split UTF-8, CRLF and a final record without a newline", async () => {
    const { child, response, close } = await setup();
    for (const byte of Buffer.from("./笔记.txt:1:匹配\r\n./笔记.txt:2:尾行")) {
      child.stdout.write(Buffer.from([byte]));
    }
    await close(0);

    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual([
      { content: "匹配", file: "projects/笔记.txt", line: 1 },
      { content: "尾行", file: "projects/笔记.txt", line: 2 },
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("stops at 100 records and waits for close before returning", async () => {
    const { child, response, close } = await setup();
    let returned = false;
    void response.then(() => {
      returned = true;
    });
    child.stdout.write(matches(101));
    child.stdout.write(matches(10));

    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await Promise.resolve();
    expect(returned).toBe(false);
    await close(null, "SIGKILL");

    const result = await response;
    expect(result.status).toBe(200);
    const results = await result.json();
    expect(results).toHaveLength(100);
    expect(results[0].line).toBe(1);
    expect(results[99].line).toBe(100);
  });

  it.each([true, false])("does not hide exit code 2 at the limit (kill=%s)", async (killed) => {
    const { child, response, close } = await setup();
    child.kill.mockReturnValue(killed);
    child.stdout.write(matches(100));
    child.stderr.write("search failed");
    await close(2);

    expect((await response).status).toBe(500);
  });

  it("keeps a diagnostic received before the limit stop on the error path", async () => {
    const { child, response, close } = await setup();
    child.stderr.write("rg: failed to read a file");
    child.stdout.write(matches(100));
    await close(null, "SIGKILL");

    expect((await response).status).toBe(500);
  });

  it("accepts a successful natural exit when the limit signal was not sent", async () => {
    const { child, response, close } = await setup();
    child.kill.mockReturnValue(false);
    child.stdout.write(matches(100));
    await close(0);

    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toHaveLength(100);
  });

  it.each(["SIGTERM", "SIGKILL"] as const)("does not accept an unsolicited %s", async (signal) => {
    const { response, close } = await setup();
    await close(null, signal);

    expect((await response).status).toBe(500);
  });

  it("keeps the missing-rg empty-result behavior", async () => {
    const { child, response, close } = await setup();
    child.emit("error", Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" }));
    await close(-2);

    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual([]);
  });

  it("reports other spawn failures", async () => {
    const { child, response, close } = await setup();
    child.emit("error", Object.assign(new Error("spawn rg EACCES"), { code: "EACCES" }));
    await close(-1);

    expect((await response).status).toBe(500);
  });

  it("bounds an unfinished output line and kills the subprocess", async () => {
    const { child, response, close } = await setup();
    const chunk = "x".repeat(64 * 1024);
    for (let index = 0; index < 17; index++) child.stdout.write(chunk);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await close(null, "SIGKILL");

    expect((await response).status).toBe(500);
  });

  it("reports a stdout stream error and cleans up the subprocess", async () => {
    const { child, response, close } = await setup();
    child.stdout.emit("error", new Error("read failed"));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await close(null, "SIGKILL");

    expect((await response).status).toBe(500);
  });

  it("drains stderr while retaining only a bounded diagnostic", async () => {
    const { child, response, close } = await setup();
    for (let index = 0; index < 32; index++) child.stderr.write("x".repeat(64 * 1024));
    await close(2);

    expect((await response).status).toBe(500);
    expect(state.logError.mock.calls[0][1].error).toHaveLength(16 * 1024);
  });
});
