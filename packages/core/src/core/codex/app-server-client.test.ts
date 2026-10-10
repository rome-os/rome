import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, rs } from "@rstest/core";
import { AppServerClient } from "./app-server-client.js";

const { spawnMock } = rs.hoisted(() => ({ spawnMock: rs.fn() }));

rs.mock("./cli.js", () => ({ spawnCodexAppServer: spawnMock }));

function fakeProc(): ChildProcessWithoutNullStreams & EventEmitter {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof rs.fn>;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = rs.fn();
  return proc as unknown as ChildProcessWithoutNullStreams & EventEmitter;
}

describe("AppServerClient", () => {
  it("rejects in-flight and post-exit requests once the app-server exited", async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const onExit = rs.fn();
    const client = new AppServerClient({
      cwd: "/",
      env: {},
      onNotification: () => undefined,
      onServerRequest: () => ({}),
      onExit,
    });
    client.start();

    const inflight = client.request("turn/start", {});
    proc.emit("exit", 1);

    // In-flight requests reject on exit…
    await expect(inflight).rejects.toThrow(/exited/);
    expect(onExit).toHaveBeenCalledWith(1);
    // …and later requests reject immediately instead of pending forever —
    // the borrowed exact-fork revert depends on this to not hang.
    await expect(client.request("thread/revert", {})).rejects.toThrow(/exited/);
  });

  it("turns a stdin EPIPE into one transport exit instead of an unhandled error", async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const onExit = rs.fn();
    const client = new AppServerClient({
      cwd: "/",
      env: {},
      onNotification: () => undefined,
      onServerRequest: () => ({}),
      onExit,
    });
    client.start();

    const inflight = client.request("turn/start", {});
    proc.stdin.emit("error", new Error("write EPIPE"));
    proc.emit("exit", 1);

    await expect(inflight).rejects.toThrow("write EPIPE");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(null);
  });
});
