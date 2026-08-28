import { describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createAction } from "./index.js";

const actionConfig = {
  name: "get_action_logs",
  type: "custom",
  description: "Fetch recent action execution logs",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

function makeDeps(rows: unknown[]): AppActionRuntimeDeps {
  return {
    appContext: {
      db: {
        connection: {
          all: () => rows,
        },
      },
    },
  } as unknown as AppActionRuntimeDeps;
}

describe("get_action_logs", () => {
  it("returns formatted logs grouped by action name", async () => {
    const rows = [
      {
        id: "1",
        action_name: "send_message",
        action_type: "system",
        status: "success",
        args: null,
        error: null,
        duration_ms: 100,
        initiator: "main",
        started_at: Math.floor(Date.now() / 1000) - 60,
        finished_at: Math.floor(Date.now() / 1000),
      },
      {
        id: "2",
        action_name: "send_message",
        action_type: "system",
        status: "error",
        args: null,
        error: "timeout",
        duration_ms: 5000,
        initiator: "main",
        started_at: Math.floor(Date.now() / 1000) - 30,
        finished_at: null,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as {
      executionCount: number;
      content: string;
    };
    expect(data.executionCount).toBe(2);
    expect(data.content).toContain("send_message");
    expect(data.content).toContain("1 succeeded");
    expect(data.content).toContain("1 failed");
    expect(data.content).toContain("timeout");
  });

  it("returns empty message when no rows", async () => {
    const action = createAction(actionConfig, makeDeps([]));
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("(No action executions found in the requested window.)");
  });

  it("returns error when DB query fails", async () => {
    const deps = {
      appContext: {
        db: {
          connection: {
            all: () => {
              throw new Error("db locked");
            },
          },
        },
      },
    } as unknown as AppActionRuntimeDeps;

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("db locked");
  });

  it("defaults windowHours to 24", async () => {
    const action = createAction(actionConfig, makeDeps([]));
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { windowHours: number };
    expect(data.windowHours).toBe(24);
  });
});
