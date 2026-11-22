import { describe, it, expect, rs } from "@rstest/core";
import type { IpcCallContext } from "../apps/actions/ipc.js";
import { routineWorkerCalls, type RoutineWorkerCallsDeps } from "./routine-calls.js";

const baseRow = {
  id: "r-7",
  name: "daily-check",
  enabled: true,
  trigger: { type: "schedule", tzid: "UTC", localTime: "09:00", rrule: "FREQ=DAILY" },
  actionName: "do_thing",
  args: {},
  createdAt: new Date(),
  lastFiredAt: null,
  nextRunAt: null,
};

function makeCalls(findById: (id: string) => Promise<unknown> = async () => baseRow) {
  const routineEngine = { activate: rs.fn(async () => {}), deactivate: rs.fn(async () => {}) };
  const calls = routineWorkerCalls({
    routinesRepo: { findById: rs.fn(findById) },
    routineEngine,
  } as unknown as RoutineWorkerCallsDeps);
  return { calls, routineEngine };
}

describe("routines.cancel", () => {
  it("rejects an empty routineId without deactivating anything", async () => {
    const { calls, routineEngine } = makeCalls();

    await expect(calls["routines.cancel"]({ routineId: "" })).rejects.toThrow(
      "routines.cancel: invalid params",
    );
    expect(routineEngine.deactivate).not.toHaveBeenCalled();
  });

  it("deactivates the routine", async () => {
    const { calls, routineEngine } = makeCalls();

    expect(await calls["routines.cancel"]({ routineId: "r-42" })).toEqual({ ok: true });
    expect(routineEngine.deactivate).toHaveBeenCalledWith("r-42");
  });
});

describe("routines.schedule", () => {
  it("activates an enabled routine", async () => {
    const { calls, routineEngine } = makeCalls();

    expect(await calls["routines.schedule"]({ routineId: "r-7" })).toEqual({ ok: true });
    expect(routineEngine.activate).toHaveBeenCalledTimes(1);
    expect(routineEngine.deactivate).not.toHaveBeenCalled();
  });

  it("deactivates a disabled routine instead of activating it", async () => {
    const { calls, routineEngine } = makeCalls(async () => ({ ...baseRow, enabled: false }));

    expect(await calls["routines.schedule"]({ routineId: "r-7" })).toEqual({ ok: true });
    expect(routineEngine.deactivate).toHaveBeenCalledWith("r-7");
    expect(routineEngine.activate).not.toHaveBeenCalled();
  });

  it("errors when the routine is not found and touches neither engine path", async () => {
    const { calls, routineEngine } = makeCalls(async () => undefined);

    await expect(calls["routines.schedule"]({ routineId: "ghost" })).rejects.toThrow(
      "Routine not found",
    );
    expect(routineEngine.activate).not.toHaveBeenCalled();
    expect(routineEngine.deactivate).not.toHaveBeenCalled();
  });
});

describe("routines.create", () => {
  const input = { name: "nudge", trigger: { type: "manual" }, actionName: "do_thing", args: {} };

  function createCalls() {
    const create = rs.fn(async () => ({ status: "ok", data: { routineId: "r-1" } }));
    const calls = routineWorkerCalls({
      routineCreation: { create },
    } as unknown as RoutineWorkerCallsDeps);
    return { calls, create };
  }

  it("creates for the person and chat of the worker's action, as the IPC boundary captured them", async () => {
    const { calls, create } = createCalls();
    const visitor = { kind: "visitor" as const, accountId: "v", email: "v@example.test" };
    const context = {
      callerActionContext: {
        actor: visitor,
        channelContext: { channel: "webchat", threadId: "chat-1" },
      },
    } as IpcCallContext;

    await calls["routines.create"]({ input, caller: { agentName: "core:main" } }, context);

    expect(create).toHaveBeenCalledWith(input, {
      kind: "action",
      agentName: "core:main",
      origin: { actor: visitor, chatId: "chat-1" },
    });
  });

  it("creates for no one when the worker's action acts for no one", async () => {
    const { calls, create } = createCalls();

    await calls["routines.create"]({ input, caller: {} }, {
      callerActionContext: {},
    } as IpcCallContext);

    expect(create).toHaveBeenCalledWith(input, { kind: "action", origin: { actor: null } });
  });
});

describe("routines.control", () => {
  function controlCalls() {
    const listRuns = rs.fn(async () => ({ status: "ok" as const, data: null }));
    const calls = routineWorkerCalls({
      routineOperations: { listRuns, readRun: rs.fn() },
    } as unknown as RoutineWorkerCallsDeps);
    return { calls, listRuns };
  }

  it("runs the operation for the turn of the worker's action, as the IPC boundary captured it", async () => {
    const { calls, listRuns } = controlCalls();
    const actor = { kind: "guardian" as const, userId: "g", via: "cookie" as const };
    const channelContext = { channel: "webchat", threadId: "chat-1" };
    const context = {
      callerActionContext: { actor, audience: "private", channelContext },
    } as IpcCallContext;

    await calls["routines.control"]({ op: "listRuns", input: { routineId: "r-1" } }, context);

    expect(listRuns).toHaveBeenCalledWith(
      { routineId: "r-1" },
      { actor, audience: "private", channelContext },
    );
  });

  it("runs it for no one when the call carries no turn", async () => {
    const { calls, listRuns } = controlCalls();

    await calls["routines.control"]({ op: "listRuns", input: {} });

    expect(listRuns).toHaveBeenCalledWith({}, {});
  });

  it("rejects an operation it does not know", async () => {
    const { calls } = controlCalls();

    await expect(calls["routines.control"]({ op: "dropTable", input: {} })).rejects.toThrow(
      "routines.control: invalid params",
    );
  });
});
