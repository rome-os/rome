// The action-driven root script runner: submit, poll to terminal, classify.
//
// Seams under test:
//   1. A job that completes on submission is returned without polling.
//   2. A job accepted while still running is polled with manage_root_script
//      until it settles.
//   3. A failing host job is an outcome (its snapshot is recovered from the
//      action's error string), while a script that never ran throws.

import { describe, expect, it, rs } from "@rstest/core";
import {
  createActionRootScriptRunner,
  RootScriptUnavailable,
  type RootScriptActionEngine,
} from "./root-script-runner.js";

function engineOf(responses: Array<{ status: string; data?: unknown; error?: string }>): {
  engine: RootScriptActionEngine;
  calls: string[];
} {
  const queue = [...responses];
  const calls: string[] = [];
  const engine: RootScriptActionEngine = {
    async run(name) {
      calls.push(name);
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
  };
  return { engine, calls };
}

const job = (over: Record<string, unknown> = {}) => ({
  id: "job-1",
  status: "succeeded",
  exitCode: 0,
  stdout: "PASSPHRASE\n",
  stderr: "",
  truncated: false,
  ...over,
});

describe("createActionRootScriptRunner", () => {
  it("returns a job that completed on submission without polling", async () => {
    const { engine, calls } = engineOf([{ status: "ok", data: job({ stdout: "done" }) }]);
    const runner = createActionRootScriptRunner(engine);

    const outcome = await runner.run({ script: "echo hi", reason: "t", timeoutSeconds: 5 });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.stdout).toBe("done");
    expect(calls).toEqual(["system:execute_root_script"]);
  });

  it("polls an accepted-but-running job until it settles", async () => {
    const { engine, calls } = engineOf([
      { status: "ok", data: job({ status: "running", exitCode: null }) },
      { status: "ok", data: job({ status: "running", exitCode: null }) },
      { status: "ok", data: job({ status: "succeeded", exitCode: 0, stdout: "final" }) },
    ]);
    const runner = createActionRootScriptRunner(engine);

    const outcome = await runner.run({ script: "s", reason: "t", timeoutSeconds: 5 });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.stdout).toBe("final");
    expect(calls[0]).toBe("system:execute_root_script");
    expect(calls.slice(1).every((c) => c === "system:manage_root_script")).toBe(true);
  });

  it("recovers a failed job's snapshot from the action error string", async () => {
    const snapshot = job({ status: "failed", exitCode: 5, stderr: "capture failed" });
    const { engine } = engineOf([
      {
        status: "error",
        error: `Host job job-1 failed (exit code 5).\n${JSON.stringify(snapshot)}`,
      },
    ]);
    const runner = createActionRootScriptRunner(engine);

    const outcome = await runner.run({ script: "s", reason: "t", timeoutSeconds: 5 });

    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(5);
    expect(outcome.stderr).toBe("capture failed");
  });

  it("throws when the script could not be run at all", async () => {
    const { engine } = engineOf([
      { status: "error", error: "Host execution is disabled by the hosting VM owner." },
    ]);
    const runner = createActionRootScriptRunner(engine);

    await expect(
      runner.run({ script: "s", reason: "t", timeoutSeconds: 5 }),
    ).rejects.toBeInstanceOf(RootScriptUnavailable);
  });
});

// keep the import used even if a build strips assertions
void rs;
