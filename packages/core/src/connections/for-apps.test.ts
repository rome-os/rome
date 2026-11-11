import { describe, it, expect, rs } from "@rstest/core";
import { connectionWorkerCalls, type ConnectionWorkerCallsDeps } from "./for-apps.js";

function makeCalls(overrides: Partial<ConnectionWorkerCallsDeps> = {}) {
  return connectionWorkerCalls({
    appConnections: {
      list: rs.fn(async () => ({ ok: true, value: { connections: [] } })),
      describe: rs.fn(),
      operations: rs.fn(),
      invoke: rs.fn(),
    } as never,
    appIdForAction: (actionName) => (actionName === "app-b:work" ? "app-b" : null),
    connectionRegistry: { ingest: rs.fn(async () => ({ status: "accepted" })) } as never,
    emailConnectionId: () => "email-1",
    ...overrides,
  });
}

describe("connections.app.*", () => {
  it("lists the connections of the app that owns the calling action", async () => {
    const list = rs.fn(async () => ({ ok: true, value: { connections: [] } }));
    const calls = makeCalls({
      appConnections: { list, describe: rs.fn(), operations: rs.fn(), invoke: rs.fn() } as never,
    });

    await calls["connections.app.list"]({ limit: 1 }, { callerActionName: "app-b:work" });

    expect(list).toHaveBeenCalledWith("app-b", { limit: 1 });
  });

  it("denies a call from an action no app owns, before reading its params", async () => {
    const calls = makeCalls();

    expect(
      await calls["connections.app.list"]({ limit: 0 }, { callerActionName: "system:x" }),
    ).toMatchObject({ ok: false, error: { code: "access_denied" } });
    expect(await calls["connections.app.list"]({})).toMatchObject({
      ok: false,
      error: { code: "access_denied" },
    });
  });

  it("answers bad params with an invalid_input result, not a throw", async () => {
    const calls = makeCalls();

    expect(
      await calls["connections.app.describe"](
        { connectionId: "" },
        { callerActionName: "app-b:work" },
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("channels.email.ingestInbound", () => {
  it("skips when no connection receives email", async () => {
    const ingest = rs.fn();
    const calls = makeCalls({
      connectionRegistry: { ingest } as never,
      emailConnectionId: () => undefined,
    });

    expect(await calls["channels.email.ingestInbound"]({ rawBody: "r", signature: "s" })).toEqual({
      status: "skipped",
      reason: "channel_inactive",
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects params without a signature", async () => {
    const calls = makeCalls();

    await expect(calls["channels.email.ingestInbound"]({ rawBody: "r" })).rejects.toThrow(
      "channels.email.ingestInbound: invalid params",
    );
  });
});
