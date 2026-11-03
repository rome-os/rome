import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, rs } from "@rstest/core";
import { AppServerClient } from "./app-server-client.js";

const { spawnMock, warnMock } = rs.hoisted(() => ({ spawnMock: rs.fn(), warnMock: rs.fn() }));

rs.mock("./cli.js", () => ({ spawnCodexAppServer: spawnMock }));
rs.mock("../../logger.js", () => ({
  createLogger: () => ({ debug: rs.fn(), info: rs.fn(), warn: warnMock, error: rs.fn() }),
}));

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
    proc.emit("exit", 1, null);

    // In-flight requests reject on exit…
    await expect(inflight).rejects.toThrow("codex app-server exited (code 1)");
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "codex app-server exited (code 1)" }),
    );
    // …and later requests reject immediately instead of pending forever —
    // the borrowed exact-fork revert depends on this to not hang.
    await expect(client.request("thread/revert", {})).rejects.toThrow(
      "codex app-server exited (code 1)",
    );
  });

  it("names the signal that killed the app-server", async () => {
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

    proc.emit("exit", null, "SIGTERM");

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "codex app-server exited (signal SIGTERM)" }),
    );
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
    proc.emit("exit", null, "SIGKILL");

    const cause = "codex app-server connection failed: write EPIPE";
    await expect(inflight).rejects.toThrow(cause);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ message: cause }));
    // The exit behind the broken pipe still reaches the log.
    expect(warnMock).toHaveBeenCalledWith("codex app-server exited after its connection failed", {
      code: null,
      signal: "SIGKILL",
      firstCause: cause,
    });
  });
});
