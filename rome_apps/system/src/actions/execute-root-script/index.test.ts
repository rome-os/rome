import { describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createAction } from "./index.js";
import { createAction as createManageAction } from "../manage-root-script/index.js";
import type { HostExecutionDeps, HostJob } from "../root-script.js";

const config: ActionConfig = {
  name: "execute_root_script",
  type: "system",
  description: "Execute a host script",
  complexity: "complex",
  speed: "moderate",
  reliability: "medium",
  sideEffects: "write",
};
const input = {
  target: "hosting-vm",
  interpreter: "sh",
  script: "printf hello",
  reason: "Check host execution",
};
const job: HostJob = {
  id: "job-1",
  requestId: "job-1",
  hostId: "host-1",
  scriptSha256: "a".repeat(64),
  status: "succeeded",
  exitCode: 0,
  stdout: "hello",
  stderr: "",
  truncated: false,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:01Z",
};

function dependencies(snapshot = job) {
  return {
    hostExecution: {
      start: rs.fn(async () => snapshot),
      inspect: rs.fn(async () => snapshot),
      cancel: rs.fn(async () => snapshot),
    },
  } satisfies HostExecutionDeps;
}

describe("host root script actions", () => {
  it("passes script inputs with the default timeout and reports successful output", async () => {
    const deps = dependencies();
    const result = await createAction(config, deps).execute(input);
    expect(deps.hostExecution.start).toHaveBeenCalledWith({ ...input, timeoutSeconds: 60 });
    expect(result).toMatchObject({
      status: "ok",
      data: { ...job, completed: true, target: "hosting-vm" },
    });
  });

  it("rejects caller-supplied audit IDs, host URLs, non-shell interpreters, and excessive UTF-8 scripts", async () => {
    const deps = dependencies();
    const action = createAction(config, deps);
    for (const patch of [
      { executionId: "forged" },
      { rootExecutionId: "forged" },
      { requestId: "forged" },
      { hostId: "host-other" },
      { url: "https://other" },
      { target: "other" },
      { interpreter: "python" },
      { timeoutSeconds: 601 },
      { script: "é".repeat(40_000) },
    ]) {
      expect(await action.execute({ ...input, ...patch })).toMatchObject({ status: "error" });
    }
    expect(deps.hostExecution.start).not.toHaveBeenCalled();
  });

  it("distinguishes accepted remote work from completion and names the cancellation path", async () => {
    const result = await createAction(
      config,
      dependencies({ ...job, status: "running", exitCode: null, finishedAt: null }),
    ).execute(input);
    expect(result).toMatchObject({
      status: "ok",
      data: {
        id: job.id,
        status: "running",
        completed: false,
        message: expect.stringContaining(
          "Stopping the Rome action or agent does not cancel this job",
        ),
      },
    });
  });

  it("maps terminal script failures and unknown outcomes to action errors with output", async () => {
    for (const status of ["failed", "timed_out", "cancelled", "unknown"] as const) {
      const result = await createAction(
        config,
        dependencies({ ...job, status, exitCode: 7, stderr: "failure", truncated: true }),
      ).execute(input);
      expect(result).toMatchObject({
        status: "error",
      });
      if (result.status !== "error") throw new Error("Expected an action error");
      expect(JSON.parse(result.error.split("\n")[1]!)).toMatchObject({
        status,
        exitCode: 7,
        stdout: "hello",
        stderr: "failure",
        truncated: true,
      });
    }
  });

  it("preserves the lookup ID after an uncertain submission", async () => {
    const deps = dependencies();
    deps.hostExecution.start.mockRejectedValueOnce(
      Object.assign(new Error("Submission outcome is unknown"), { jobId: "lookup-1" }),
    );
    const result = await createAction(config, deps).execute(input);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("Expected an action error");
    expect(JSON.parse(result.error.split("\n")[1]!)).toEqual({
      jobId: "lookup-1",
      target: "hosting-vm",
      completed: false,
    });
  });

  it("returns a readable error when the runtime does not supply host execution", async () => {
    expect(await createAction(config, {}).execute(input)).toMatchObject({
      status: "error",
      error: expect.stringContaining("unavailable"),
    });
  });

  it("routes explicit inspection and cancellation to the same durable job", async () => {
    const deps = dependencies();
    const action = createManageAction({ ...config, name: "manage_root_script" }, deps);
    expect(
      await action.execute({ target: "hosting-vm", operation: "inspect", jobId: job.id }),
    ).toMatchObject({ status: "ok", data: { id: job.id } });
    expect(
      await action.execute({ target: "hosting-vm", operation: "cancel", jobId: job.id }),
    ).toMatchObject({ status: "ok", data: { id: job.id } });
    expect(deps.hostExecution.inspect).toHaveBeenCalledWith(job.id);
    expect(deps.hostExecution.cancel).toHaveBeenCalledWith(job.id);
    expect(deps.hostExecution.start).not.toHaveBeenCalled();
  });
});
