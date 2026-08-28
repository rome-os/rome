import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createClaudeQueryProcess } from "./claude-query-process.js";

rs.mock("node:child_process", () => ({ spawn: rs.fn() }));

function setup() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: rs.fn((_signal?: NodeJS.Signals) => {
      child.killed = true;
      return true;
    }),
  });
  rs.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const owner = createClaudeQueryProcess();
  owner.abortController.signal.addEventListener("abort", () => child.kill("SIGTERM"));
  owner.spawn({ command: "claude", args: [], env: {}, signal: owner.abortController.signal });
  return { owner, child };
}

afterEach(() => {
  rs.useRealTimers();
  rs.clearAllMocks();
});

describe("Claude Query process cancellation", () => {
  it("waits for actual exit rather than the killed flag", async () => {
    const { owner, child } = setup();
    let finished = false;
    const abort = owner.abort().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(owner.abortController.signal.aborted).toBe(true);
    expect(child.killed).toBe(true);
    expect(finished).toBe(false);
    child.emit("exit", null, "SIGTERM");
    await abort;
    expect(finished).toBe(true);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  it("escalates only the owned process when SIGTERM does not exit", async () => {
    rs.useFakeTimers();
    const { owner, child } = setup();
    const abort = owner.abort();
    await rs.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    child.emit("exit", null, "SIGKILL");
    await abort;
    await rs.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("reports an unconfirmed exit and permits another cancellation attempt", async () => {
    rs.useFakeTimers();
    const { owner, child } = setup();
    const first = expect(owner.abort()).rejects.toThrow("did not exit");
    await rs.advanceTimersByTimeAsync(2_000);
    await first;
    const second = owner.abort();
    child.emit("exit", null, "SIGKILL");
    await second;
  });

  it("does not signal an exited process again", async () => {
    const { owner, child } = setup();
    const abort = owner.abort();
    child.emit("exit", 0, null);
    await abort;
    await owner.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
