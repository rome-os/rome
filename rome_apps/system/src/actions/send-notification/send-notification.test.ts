import { describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createAction, createSendNotificationAction } from "./index.js";
import type { SendNotificationDeps, SendOutcome } from "./index.js";

const config = { name: "send_notification", type: "system" } as unknown as ActionConfig;

const withOutcome = (outcome: SendOutcome) =>
  createSendNotificationAction(config, { notify: { send: rs.fn(async () => outcome) } });

// Exposes the notify.send spy so a test can assert exactly what content the
// action forwarded.
const withSpy = () => {
  const send = rs.fn(async () => ({ kind: "ok", attempted: 1, sent: 1, failed: 0 }) as SendOutcome);
  return { action: createSendNotificationAction(config, { notify: { send } }), send };
};

const withThrow = (err: unknown) =>
  createSendNotificationAction(config, {
    notify: {
      send: rs.fn(async () => {
        throw err;
      }),
    },
  });

describe("send_notification action", () => {
  it("exposes an optional string body input and disallows unknown keys", () => {
    const schema = withOutcome({ kind: "no_token" }).inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties?.body).toEqual({ type: "string" });
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required ?? []).not.toContain("body"); // body is optional
  });

  it("forwards a custom body to notify.send", async () => {
    const { action, send } = withSpy();
    await action.execute({ body: "Build failed" });
    expect(send).toHaveBeenCalledWith({ body: "Build failed" });
  });

  it("forwards an empty-string body unchanged (Rome Cloud owns the fallback)", async () => {
    const { action, send } = withSpy();
    await action.execute({ body: "" });
    expect(send).toHaveBeenCalledWith({ body: "" });
  });

  it("forwards a whitespace-only body unchanged (never action-trimmed/dropped)", async () => {
    const { action, send } = withSpy();
    await action.execute({ body: "   " });
    expect(send).toHaveBeenCalledWith({ body: "   " });
  });

  it("forwards no content for a zero-argument call", async () => {
    const { action, send } = withSpy();
    await action.execute({});
    expect(send).toHaveBeenCalledWith(undefined);
  });

  it("rejects a non-string body without calling notify.send (fail closed)", async () => {
    const { action, send } = withSpy();
    const r = await action.execute({ body: 123 } as unknown as Record<string, unknown>);
    expect(r.status).toBe("error");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an unknown/typo'd key without calling notify.send", async () => {
    const { action, send } = withSpy();
    const r = await action.execute({ bodu: "typo" } as unknown as Record<string, unknown>);
    expect(r.status).toBe("error");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a valid body carrying an extra key without calling notify.send", async () => {
    const { action, send } = withSpy();
    const r = await action.execute({ body: "hi", extra: 1 } as unknown as Record<string, unknown>);
    expect(r.status).toBe("error");
    expect(send).not.toHaveBeenCalled();
  });

  it("maps ok with sent>0 to status ok with the counts", async () => {
    const r = await withOutcome({ kind: "ok", attempted: 2, sent: 1, failed: 1 }).execute({});
    expect(r).toEqual({ status: "ok", data: { attempted: 2, sent: 1, failed: 1 } });
  });

  it("maps ok with attempted===0 to no_devices", async () => {
    const r = await withOutcome({ kind: "ok", attempted: 0, sent: 0, failed: 0 }).execute({});
    expect(r).toEqual({ status: "error", error: "no_devices" });
  });

  it("maps ok with attempted>0 and sent===0 to sent_zero", async () => {
    const r = await withOutcome({ kind: "ok", attempted: 3, sent: 0, failed: 3 }).execute({});
    expect(r).toEqual({ status: "error", error: "sent_zero" });
  });

  it("maps no_token / unconfigured / reenroll / outcome_unknown to their error codes", async () => {
    expect(await withOutcome({ kind: "no_token" }).execute({})).toEqual({
      status: "error",
      error: "no_token",
    });
    expect(await withOutcome({ kind: "unconfigured" }).execute({})).toEqual({
      status: "error",
      error: "unconfigured",
    });
    expect(await withOutcome({ kind: "reenroll" }).execute({})).toEqual({
      status: "error",
      error: "instance_reenrollment_required",
    });
    expect(await withOutcome({ kind: "outcome_unknown" }).execute({})).toEqual({
      status: "error",
      error: "notification_outcome_unknown",
    });
  });

  it("rethrows an unexpected error from the notify capability", async () => {
    await expect(withThrow(new Error("boom")).execute({})).rejects.toThrow("boom");
  });

  it("maps an unknown outcome kind to notification_outcome_unknown", async () => {
    const result = await withOutcome({
      kind: "future_outcome",
    } as unknown as SendOutcome).execute({});

    expect(result).toEqual({
      status: "error",
      error: "notification_outcome_unknown",
    });
  });

  it("createAction throws at load when the notify capability is missing or malformed", () => {
    expect(() => createAction(config, {} as unknown as SendNotificationDeps)).toThrow(
      /notify capability/,
    );
    expect(() => createAction(config, { notify: {} } as unknown as SendNotificationDeps)).toThrow(
      /notify capability/,
    );
    // A well-formed dep loads fine.
    expect(() => createAction(config, { notify: { send: rs.fn() } })).not.toThrow();
  });
});
