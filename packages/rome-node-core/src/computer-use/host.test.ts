import { afterEach, describe, expect, it } from "@rstest/core";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type ActionResponse } from "../actions.js";
import { createComputerUseHost } from "./host.js";
import { ComputerUseLedger } from "./ledger.js";
import { ComputerUseError } from "./protocol.js";

const temporary: string[] = [];
const windowSemanticsCapabilities = {
  actions: ["click", "press", "setValue", "selectText"],
  coordinateSpace: "window_image_pixels",
  realPointer: false,
  inputIsolation: "window_semantics",
  transport: "ax_only",
};

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function value(response: ActionResponse): Record<string, unknown> {
  expect(response.ok).toBe(true);
  if (!response.ok || !isRecord(response.result)) throw new Error("Expected result");
  return response.result;
}

async function fixture() {
  const stateDir = await mkdtemp("/tmp/rome-cua-test-");
  temporary.push(stateDir);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let clock = 100;
  let wall = 1_000_000;
  let busy = false;
  let pid = 42;
  let instanceId: string | undefined = "helper-one";
  let capabilities: Record<string, unknown> | undefined;
  let sessionEnd = false;
  let windowLease = false;
  let preempt: ((params: Record<string, unknown>) => Promise<unknown>) | undefined;
  let stopStatus: ((params: Record<string, unknown>) => Promise<unknown>) | undefined;
  const lease = { idleTimeoutMs: 30_000, renewAfterMs: 10_000, remainingMs: 29_900 };
  let finish: (params: Record<string, unknown>) => Promise<unknown> = async (params) => ({
    sessionId: params.sessionId,
    terminalCause: "completed",
    stopConfirmed: true,
  });
  let dispatch: (params: Record<string, unknown>) => Promise<unknown> = async (params) => ({
    sessionId: params.sessionId,
    actionId: params.actionId,
    status: "dispatched_unverified",
    effectVerified: false,
    eventsPosted: 0,
    operationsDispatched: 1,
  });
  let verify: (params: Record<string, unknown>) => Promise<unknown> = async (params) => ({
    ...params,
    status: "verified",
    effectVerified: true,
  });
  let cancellation: (params: Record<string, unknown>) => Promise<unknown> = async () => ({
    status: "cancelled",
    terminalCause: "cancelled",
  });
  const native = {
    async call(method: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params });
      if (method === "hello")
        return {
          protocolVersion: 1,
          pid,
          ...(instanceId === undefined ? {} : { instanceId }),
          permissions: { accessibility: true, screenCapture: true },
          capabilities: {
            actions: ["setValue"],
            background: {
              sessionEnd,
              windowLease,
              windowPreemption: preempt !== undefined,
              sessionRecovery: stopStatus !== undefined,
            },
          },
          execution: { busy },
        };
      if (method === "windows")
        return { windows: [{ windowRef: "window-token", appName: "TextEdit" }] };
      if (method === "bind")
        return {
          sessionId: params.sessionId,
          scope: "background",
          status: "bound",
          expiresAt: wall / 1000 + 600,
          ...(capabilities ? { capabilities } : {}),
          ...(params.lease ? { lease } : {}),
        };
      if (method === "renew") return { sessionId: params.sessionId, status: "renewed", lease };
      if (method === "observe")
        return {
          sessionId: params.sessionId,
          observationId: `observation-${calls.length}`,
          stateVersion: calls.length,
          validity: {
            observedAt: wall / 1000,
            expiresAt: wall / 1000 + 15,
            maxAgeSeconds: 15,
            clock: "remote_wall_time",
          },
          elements: [
            { ref: "element-token", role: "AXTextArea", value: "", actions: ["setValue"] },
          ],
          complete: true,
          ...(params.screenshot
            ? {
                screenshot: {
                  mimeType: "image/png",
                  width: 1,
                  height: 1,
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mL8AAAAASUVORK5CYII=",
                },
              }
            : {}),
        };
      if (method === "act") {
        const receipt = await dispatch(params);
        return isRecord(receipt)
          ? { sessionId: params.sessionId, actionId: params.actionId, ...receipt }
          : receipt;
      }
      if (method === "verify") return verify(params);
      if (method === "cancel") return cancellation(params);
      if (method === "end") return finish(params);
      if (method === "preempt" && preempt) return preempt(params);
      if (method === "stop_status" && stopStatus) return stopStatus(params);
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const options = {
    stateDir,
    native,
    platform: "darwin" as const,
    now: () => wall,
    monotonicNow: () => clock,
  };
  const host = createComputerUseHost(options);
  async function bound() {
    return String(
      value(await host.run("computer.bind", { windowRef: "window-token" }, "owner")).sessionId,
    );
  }
  async function observed(sessionId: string) {
    return value(await host.run("computer.observe", { sessionId }, "owner"));
  }
  async function act(sessionId: string, actionId = "action-1") {
    const observation = await observed(sessionId);
    return {
      sessionId,
      actionId,
      observationId: observation.observationId,
      stateVersion: observation.stateVersion,
      ref: "element-token",
      action: { type: "setValue", value: "private draft text" },
    };
  }
  return {
    host,
    stateDir,
    calls,
    native,
    options,
    bound,
    observed,
    act,
    advance: (ms: number) => {
      clock += ms;
      wall += ms;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
    setHelper: (nextPid: number, nextInstanceId?: string) => {
      pid = nextPid;
      instanceId = nextInstanceId;
    },
    setDispatch: (fn: typeof dispatch) => {
      dispatch = fn;
    },
    setVerification: (fn: typeof verify) => {
      verify = fn;
    },
    setCancellation: (fn: typeof cancellation) => {
      cancellation = fn;
    },
    setCapabilities: (value: Record<string, unknown>) => {
      capabilities = value;
    },
    enableEnd: () => {
      sessionEnd = true;
      capabilities = { actions: ["setValue"], sessionEnd: true };
    },
    setPreempt: (run: typeof preempt) => {
      preempt = run;
    },
    setStopStatus: (run: typeof stopStatus) => {
      stopStatus = run;
    },
    setEnd: (fn: typeof finish) => {
      finish = fn;
    },
    enableLease: () => {
      windowLease = true;
      capabilities = { actions: ["setValue"], windowLease: true };
    },
    windowDirected: () => {
      capabilities = {
        actions: [
          "move",
          "click",
          "drag",
          "scroll",
          "key",
          "type",
          "press",
          "setValue",
          "selectText",
          "performAction",
        ],
        coordinateSpace: "window_image_pixels",
        realPointer: false,
        partialObservations: true,
        maxValueLength: 16384,
        maxTextLength: 4096,
      };
    },
  };
}

describe("shared computer-use host", () => {
  it("rejects regions before calling an older helper and keeps whole-window reads usable", async () => {
    const f = await fixture();
    const sessionId = await f.bound();
    const region = { x: 1, y: 2, width: 10, height: 20 };
    expect(await f.host.run("computer.observe", { sessionId, region }, "owner")).toMatchObject({
      ok: false,
      error: { code: "observation_region_unsupported" },
    });
    expect(f.calls.filter(({ method }) => method === "observe")).toEqual([]);
    expect(await f.observed(sessionId)).not.toHaveProperty("region");
  });

  it("requires the requested region echo and resets the baseline when its scope changes", async () => {
    const f = await fixture();
    const region = { x: 1, y: 2, width: 10, height: 20 };
    const reverse = { ...region, fromEnd: true };
    let echo = region;
    f.setCapabilities({ ...windowSemanticsCapabilities, observationRegion: true });
    const host = createComputerUseHost({
      ...f.options,
      native: {
        async call(method, params) {
          const response = await f.native.call(method, params);
          if (method !== "observe" || !isRecord(response)) return response;
          return {
            ...response,
            region: echo,
            delta: {
              mode: "full",
              lineageId: "fromEnd" in echo ? "reverse" : "forward",
              baseVersion: null,
              version: response.stateVersion,
              complete: true,
              added: ["element-token"],
              changed: [],
              removed: [],
            },
          };
        },
      },
    });
    const sessionId = value(
      await host.run("computer.bind", { windowRef: "window" }, "owner"),
    ).sessionId;
    const first = value(await host.run("computer.observe", { sessionId, region }, "owner"));
    const next = { sessionId, region: reverse, baseVersion: first.stateVersion };
    expect(await host.run("computer.observe", next, "owner")).toMatchObject({
      ok: false,
      error: { code: "invalid_helper_response" },
    });
    echo = reverse;
    expect(value(await host.run("computer.observe", next, "owner"))).toMatchObject({
      region: reverse,
    });
    expect(
      f.calls.filter(({ method }) => method === "observe").map(({ params }) => params),
    ).toEqual([
      { sessionId, full: true, screenshot: false, region },
      { sessionId, full: true, screenshot: false, region: reverse },
      { sessionId, full: true, screenshot: false, region: reverse },
    ]);
  });

  it("requires explicit preemption authority, keeps pending replacements closed, and strips the old native ID", async () => {
    const f = await fixture();
    const old = await f.bound();
    const args = { windowRef: "window-token", preemptToken: "incumbent-token" };
    const authority = { allowPreemption: true } as const;
    f.calls.length = 0;
    expect(await f.host.run("computer.preempt", args, "new-owner")).toMatchObject({
      ok: false,
      error: { code: "preemption_denied", details: { effectStatus: "not_dispatched" } },
    });
    expect(f.calls).toHaveLength(0);
    f.setPreempt(async () => {
      throw new ComputerUseError("preemption_pending", "Pending", { stopConfirmed: false });
    });
    expect(await f.host.run("computer.preempt", args, "new-owner", authority)).toMatchObject({
      ok: false,
      error: { code: "preemption_pending" },
    });
    f.setPreempt(async (input) => ({
      sessionId: input.sessionId,
      scope: "background",
      status: "bound",
      capabilities: { actions: ["setValue"], windowPreemption: true },
      preemptedSessionId: old,
      preemption: { terminalCause: "preempted", stopConfirmed: true },
    }));
    const replacement = value(await f.host.run("computer.preempt", args, "new-owner", authority));
    expect(replacement.sessionId).not.toBe(old);
    expect(replacement).not.toHaveProperty("preemptedSessionId");
    expect(replacement).toHaveProperty("preemption.stopConfirmed", true);
    expect(await f.host.run("computer.observe", { sessionId: old }, "owner")).toMatchObject({
      ok: false,
      error: { code: "session_stopped", details: { terminalCause: "preempted" } },
    });
  });

  it("recovers verified metadata from a new Host without inspecting a window", async () => {
    const f = await fixture();
    f.enableEnd();
    const sessionId = await f.bound();
    const input = await f.act(sessionId);
    value(await f.host.run("computer.act", input, "owner"));
    value(await f.host.run("computer.verify", { sessionId, actionId: input.actionId }, "owner"));
    value(await f.host.run("computer.end", { sessionId }, "owner"));
    f.calls.length = 0;
    const restarted = createComputerUseHost(f.options);
    expect(
      await restarted.run("computer.recover", { actionId: input.actionId }, "stranger"),
    ).toMatchObject({
      ok: false,
      error: { code: "unknown_action" },
    });
    const recovered = value(
      await restarted.run("computer.recover", { actionId: input.actionId }, "owner"),
    );
    expect(recovered).toMatchObject({
      sessionId,
      actionId: input.actionId,
      status: "dispatched_unverified",
      effectVerified: true,
      verificationStatus: "verified",
      stopConfirmed: true,
      terminalCause: "completed",
    });
    expect(JSON.stringify(recovered)).not.toContain("private draft text");
    expect(f.calls).toHaveLength(0);
    expect(await restarted.run("computer.observe", { sessionId }, "owner")).toMatchObject({
      ok: false,
      error: { code: "unknown_session" },
    });
  });

  it("rechecks a transient geometry change using only the original verification query", async () => {
    const f = await fixture();
    f.enableEnd();
    const input = await f.act(await f.bound());
    const { sessionId, actionId } = input;
    const query = { sessionId, actionId };
    value(await f.host.run("computer.act", input, "owner"));
    let attempts = 0;
    f.setVerification(async (params) => {
      if (++attempts === 1)
        throw new ComputerUseError("window_geometry_changed", "Window geometry changed.");
      return { ...params, status: "verified", effectVerified: true };
    });
    expect(value(await f.host.run("computer.verify", query, "owner"))).toMatchObject({
      ...query,
      effectVerified: true,
    });
    expect(f.calls.filter(({ method }) => method === "verify")).toEqual([
      { method: "verify", params: query },
      { method: "verify", params: query },
    ]);
    expect(f.calls.filter(({ method }) => method === "act")).toHaveLength(1);
    value(await f.host.run("computer.end", { sessionId }, "owner"));
    const restarted = createComputerUseHost(f.options);
    expect(value(await restarted.run("computer.recover", { actionId }, "owner"))).toMatchObject({
      ...query,
      operationsDispatched: 1,
      effectVerified: true,
      stopConfirmed: true,
    });
  });

  it("leaves dispatched evidence unverified if the geometry check keeps failing", async () => {
    const f = await fixture();
    const input = await f.act(await f.bound());
    const { sessionId, actionId } = input;
    value(await f.host.run("computer.act", input, "owner"));
    f.setVerification(async () => {
      throw new ComputerUseError("window_geometry_changed", "Window geometry changed.");
    });
    expect(await f.host.run("computer.verify", { sessionId, actionId }, "owner")).toMatchObject({
      ok: false,
      error: { code: "window_geometry_changed" },
    });
    expect(f.calls.filter(({ method }) => method === "verify")).toHaveLength(2);
    expect(f.calls.filter(({ method }) => method === "act")).toHaveLength(1);
    expect(value(await f.host.run("computer.recover", { actionId }, "owner"))).toMatchObject({
      sessionId,
      status: "dispatched_unverified",
      effectVerified: false,
    });
  });

  it("does not retry the read across a disconnect", async () => {
    const f = await fixture();
    const input = await f.act(await f.bound());
    const { sessionId, actionId } = input;
    value(await f.host.run("computer.act", input, "owner"));
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let rejectRead!: (error: ComputerUseError) => void;
    const firstRead = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    f.setVerification(async () => {
      started();
      return firstRead;
    });
    f.setCancellation(async () => ({
      sessionId,
      terminalCause: "connection_lost",
      stopConfirmed: true,
    }));
    const verifying = f.host.run("computer.verify", { sessionId, actionId }, "owner");
    await began;
    f.host.disconnect();
    rejectRead(new ComputerUseError("window_geometry_changed", "Window geometry changed."));
    expect(await verifying).toMatchObject({
      ok: false,
      error: { code: "window_geometry_changed" },
    });
    await f.host.idle();
    expect(f.calls.filter(({ method }) => method === "verify")).toHaveLength(1);
    expect(f.calls.filter(({ method }) => method === "act")).toHaveLength(1);
    expect(value(await f.host.run("computer.recover", { actionId }, "owner"))).toMatchObject({
      status: "dispatched_unverified",
      effectVerified: false,
      terminalCause: "connection_lost",
      stopConfirmed: true,
    });
  });

  it("rejects foreign verification identifiers before recording any effect", async () => {
    const f = await fixture();
    const input = await f.act(await f.bound());
    const { sessionId, actionId } = input;
    value(await f.host.run("computer.act", input, "owner"));
    for (const wrong of [{ sessionId: "another-session" }, { actionId: "another-action" }]) {
      f.setVerification(async (params) => ({
        ...params,
        ...wrong,
        status: "verified",
        effectVerified: true,
      }));
      expect(await f.host.run("computer.verify", { sessionId, actionId }, "owner")).toMatchObject({
        ok: false,
        error: { code: "invalid_helper_response" },
      });
    }
    expect(value(await f.host.run("computer.recover", { actionId }, "owner"))).toMatchObject({
      sessionId,
      status: "dispatched_unverified",
      effectVerified: false,
    });
    expect(f.calls.filter(({ method }) => method === "verify")).toHaveLength(2);
  });

  it("records an unknown outcome for a foreign dispatch receipt and prevents replay", async () => {
    const f = await fixture();
    const input = await f.act(await f.bound());
    const { sessionId, actionId } = input;
    f.setDispatch(async () => ({
      actionId: "another-action",
      status: "dispatched_unverified",
      effectVerified: false,
      operationsDispatched: 1,
    }));
    expect(await f.host.run("computer.act", input, "owner")).toMatchObject({
      ok: false,
      error: { code: "unknown_outcome", details: { originalCode: "invalid_helper_response" } },
    });
    await f.host.run("computer.act", input, "owner");
    expect(f.calls.filter(({ method }) => method === "act")).toHaveLength(1);
    expect(value(await f.host.run("computer.recover", { actionId }, "owner"))).toMatchObject({
      sessionId,
      status: "unknown",
      effectVerified: false,
    });
  });

  it("checks unconfirmed recovery with a read-only native stop status and never repeats the input", async () => {
    const f = await fixture();
    const sessionId = await f.bound();
    const input = await f.act(sessionId);
    f.setDispatch(async () => {
      throw new ComputerUseError("helper_timeout", "Lost reply");
    });
    expect(await f.host.run("computer.act", input, "owner")).toMatchObject({
      ok: false,
      error: { code: "unknown_outcome" },
    });
    f.calls.length = 0;
    f.setStopStatus(async () => ({ sessionId, status: "active", stopConfirmed: false }));
    const restarted = createComputerUseHost(f.options);
    expect(
      value(await restarted.run("computer.recover", { actionId: input.actionId }, "owner")),
    ).toMatchObject({
      status: "unknown",
      effectVerified: false,
      stopConfirmed: false,
    });
    f.setStopStatus(async () => ({
      sessionId,
      terminalCause: "host_stopped",
      stopConfirmed: true,
    }));
    expect(
      value(await restarted.run("computer.recover", { actionId: input.actionId }, "owner")),
    ).toMatchObject({
      status: "unknown",
      effectVerified: false,
      stopConfirmed: true,
    });
    const methods = f.calls.map((call) => call.method);
    expect(methods.filter((method) => method === "stop_status")).toHaveLength(2);
    expect(methods.every((method) => method === "hello" || method === "stop_status")).toBe(true);
  });

  it("requires advertised opt-in leases and keeps renewal scoped to the owner", async () => {
    const f = await fixture();
    const args = { windowRef: "window-token", lease: true };
    expect(await f.host.run("computer.bind", args, "owner")).toMatchObject({
      ok: false,
      error: { code: "window_lease_unsupported" },
    });
    expect(f.calls.map(({ method }) => method)).toEqual(["hello"]);
    f.enableLease();
    const { sessionId, lease } = value(await f.host.run("computer.bind", args, "owner"));
    expect(lease).toMatchObject({ idleTimeoutMs: 30_000, renewAfterMs: 10_000 });
    expect(await f.host.run("computer.renew", { sessionId }, "other")).toMatchObject({
      ok: false,
      error: { code: "unknown_session" },
    });
    expect(value(await f.host.run("computer.renew", { sessionId }, "owner"))).toEqual({
      sessionId,
      status: "renewed",
      lease,
    });
    await f.host.run("computer.cancel", { sessionId }, "owner");
    expect(await f.host.run("computer.renew", { sessionId }, "owner")).toMatchObject({
      ok: false,
      error: { code: "session_stopped" },
    });
    expect(f.calls.filter(({ method }) => method === "renew")).toHaveLength(1);
  });

  it("starts a native lease for protected bindings when the helper advertises one", async () => {
    const f = await fixture();
    const args = { windowRef: "window-token" };
    const authority = { leaseIfAvailable: true } as const;
    const older = value(await f.host.run("computer.bind", args, "owner", authority));
    expect(older).not.toHaveProperty("lease");
    f.enableLease();
    const direct = value(await f.host.run("computer.bind", args, "owner"));
    expect(direct).not.toHaveProperty("lease");
    const protectedBinding = value(await f.host.run("computer.bind", args, "owner", authority));
    expect(protectedBinding.lease).toMatchObject({ idleTimeoutMs: 30_000, renewAfterMs: 10_000 });
    expect(
      f.calls.filter(({ method }) => method === "bind").map(({ params }) => params.lease),
    ).toEqual([undefined, undefined, true]);
  });

  it("requires explicit stop support before a one-shot binding on an old helper", async () => {
    const f = await fixture();
    const response = await f.host.run(
      "computer.bind",
      { windowRef: "window-token", requireSessionEnd: true },
      "owner",
    );
    expect(response).toMatchObject({ ok: false, error: { code: "session_end_unsupported" } });
    expect(f.calls.map(({ method }) => method)).toEqual(["hello"]);
    await f.bound();
  });

  it("latches end before the native reply and keeps an earlier verified action readable", async () => {
    const f = await fixture();
    f.enableEnd();
    const args = await f.act(await f.bound());
    const { sessionId, actionId } = args;
    await f.host.run("computer.act", args, "owner");
    const verified = value(await f.host.run("computer.verify", { sessionId, actionId }, "owner"));
    expect(verified.status).toBe("verified");

    const wrongPeer = await f.host.run("computer.end", { sessionId }, "other");
    expect(wrongPeer).toMatchObject({ ok: false, error: { code: "unknown_session" } });
    let finish!: (result: unknown) => void;
    f.setEnd(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const ending = f.host.run("computer.end", { sessionId }, "owner");
    const alsoEnding = f.host.run("computer.end", { sessionId }, "owner");
    const rejected = await f.host.run("computer.act", { ...args, actionId: "late" }, "owner");
    expect(rejected).toMatchObject({ ok: false, error: { code: "session_stopped" } });
    expect(f.calls.map(({ method }) => method).filter((method) => method === "act")).toHaveLength(
      1,
    );
    finish({ sessionId, terminalCause: "completed", stopConfirmed: true });
    expect(value(await ending)).toMatchObject({ status: "completed", stopConfirmed: true });
    expect(await alsoEnding).toEqual(await ending);

    expect(
      value(await f.host.run("computer.verify", { sessionId, actionId }, "owner")),
    ).toMatchObject({ status: "verified", terminalCause: "completed", effectVerified: true });
    expect(f.calls.map(({ method }) => method).filter((method) => method === "end")).toHaveLength(
      1,
    );
  });

  it("keeps admission closed when stop is unconfirmed and preserves an earlier terminal cause", async () => {
    const f = await fixture();
    f.enableEnd();
    const sessionId = await f.bound();
    f.setEnd(async () => ({ sessionId, terminalCause: "takeover", stopConfirmed: false }));
    expect(value(await f.host.run("computer.end", { sessionId }, "owner"))).toMatchObject({
      status: "stop_pending",
      terminalCause: "takeover",
      stopConfirmed: false,
    });
    expect(await f.host.run("computer.observe", { sessionId }, "owner")).toMatchObject({
      ok: false,
      error: { code: "session_stopped" },
    });
    f.setEnd(async () => ({ sessionId, terminalCause: "takeover", stopConfirmed: true }));
    expect(value(await f.host.run("computer.end", { sessionId }, "owner"))).toMatchObject({
      status: "takeover",
      terminalCause: "takeover",
      stopConfirmed: true,
    });
  });

  it.each([
    { scope: "desktop" },
    { capabilities: { actions: ["click"], realPointer: true } },
  ])("cancels a returned native binding that could contend for foreground input: %j", async (bad) => {
    const f = await fixture(),
      original = f.native.call.bind(f.native);
    f.native.call = async (method, params) => {
      const reply = await original(method, params);
      return method === "bind" && isRecord(reply) ? { ...reply, ...bad } : reply;
    };
    expect(await f.host.run("computer.bind", { windowRef: "window-token" }, "owner")).toMatchObject(
      { ok: false, error: { code: "background_control_required" } },
    );
    expect(f.calls.filter((call) => call.method === "cancel")).toHaveLength(1);
    expect(f.calls.some((call) => call.method === "act")).toBe(false);
  });

  it("honors advertised actions and text limits without promoting legacy background bindings", async () => {
    const f = await fixture();
    f.setCapabilities({
      actions: ["click", "setValue", "type"],
      coordinateSpace: "window_image_pixels",
      realPointer: false,
      partialObservations: true,
      maxValueLength: 2,
      maxTextLength: 2,
    });
    const modern = await f.bound(),
      args = await f.act(modern);
    expect(
      await f.host.run("computer.act", { ...args, action: { type: "press" } }, "owner"),
    ).toMatchObject({ ok: false, error: { code: "unsupported_action" } });
    expect(
      await f.host.run(
        "computer.act",
        { ...args, action: { type: "setValue", value: "xxx" } },
        "owner",
      ),
    ).toMatchObject({ ok: false, error: { code: "unsupported_action" } });
    expect(
      await f.host.run("computer.act", { ...args, action: { type: "type", text: "xxx" } }, "owner"),
    ).toMatchObject({ ok: false, error: { code: "unsupported_action" } });
    expect(
      value(
        await f.host.run(
          "computer.act",
          { ...args, action: { type: "setValue", value: "😀" } },
          "owner",
        ),
      ),
    ).toHaveProperty("status", "dispatched_unverified");
    f.setCapabilities({ actions: ["click", "setValue"], maxValueLength: 16384 });
    const legacy = await f.bound(),
      oldArgs = await f.act(legacy, "legacy");
    for (const action of [
      { type: "click", x: 1, y: 1 },
      { type: "setValue", value: "x".repeat(181) },
    ])
      expect(await f.host.run("computer.act", { ...oldArgs, action }, "owner")).toMatchObject({
        ok: false,
        error: { code: "unsupported_action" },
      });
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(1);
  });

  it("keeps same-application window semantics ref-only and requires advertised element actions", async () => {
    const f = await fixture();
    f.setCapabilities(windowSemanticsCapabilities);
    const sessionId = await f.bound(),
      args = await f.act(sessionId);
    for (const action of [
      { type: "key", key: "A", modifiers: ["command"] },
      { type: "type", text: "中文😀" },
      { type: "move", x: 1, y: 1 },
      { type: "drag", x: 1, y: 1, toX: 2, toY: 2 },
      { type: "scroll", deltaY: 1 },
      { type: "performAction", action: "AXPress" },
      { type: "click", x: 1, y: 1 },
      { type: "click", button: "right" },
      { type: "click", clickCount: 2 },
    ])
      expect(await f.host.run("computer.act", { ...args, action }, "owner")).toMatchObject({
        ok: false,
        error: { code: "unsupported_action" },
      });
    expect(
      await f.host.run(
        "computer.act",
        { ...args, ref: undefined, action: { type: "setValue", value: "中文😀" } },
        "owner",
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const click = { ...args, action: { type: "click" } };
    expect(
      await f.host.run("computer.act", { ...click, ref: "missing-ref" }, "owner"),
    ).toMatchObject({ ok: false, error: { code: "stale_observation" } });
    expect(await f.host.run("computer.act", click, "owner")).toMatchObject({
      ok: false,
      error: { code: "unsupported_action", details: { effectStatus: "not_dispatched" } },
    });
    expect(f.calls.some((call) => call.method === "act")).toBe(false);
    expect(await readdir(f.stateDir)).not.toContain("ledger");
    expect(
      value(
        await f.host.run(
          "computer.act",
          { ...args, action: { type: "setValue", value: "中文😀" } },
          "owner",
        ),
      ),
    ).toHaveProperty("status", "dispatched_unverified");
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(1);
  });

  it.each([
    {
      actions: ["key"],
      coordinateSpace: "window_image_pixels",
      realPointer: false,
      transport: "ax_only",
    },
    {
      actions: ["setValue"],
      coordinateSpace: "window_image_pixels",
      realPointer: false,
      transport: "window_pid_events",
    },
    { actions: ["setValue"], realPointer: false, transport: "ax_only" },
  ])("closes an unsafe window-semantic binding before input: %j", async (capabilities) => {
    const f = await fixture();
    f.setCapabilities({ ...capabilities, inputIsolation: "window_semantics" });
    expect(await f.host.run("computer.bind", { windowRef: "window-token" }, "owner")).toMatchObject(
      { ok: false, error: { code: "invalid_helper_response" } },
    );
    expect(f.calls.filter((call) => call.method === "cancel")).toHaveLength(1);
    expect(f.calls.some((call) => call.method === "act")).toBe(false);
  });

  it("retains the state baseline after an action while returning only the next wire delta", async () => {
    const f = await fixture();
    f.windowDirected();
    const original = f.native.call.bind(f.native);
    let version = 0;
    f.native.call = async (method, params) => {
      const reply = await original(method, params);
      if (method !== "observe" || !isRecord(reply)) return reply;
      version++;
      const full = version === 1 || params.full === true || params.baseVersion !== version - 1;
      return {
        ...reply,
        stateVersion: version,
        elements: full ? reply.elements : [],
        delta: {
          mode: full ? "full" : "delta",
          lineageId: "window-lineage",
          baseVersion: full ? null : version - 1,
          version,
          complete: true,
          added: full ? ["element-token"] : [],
          changed: [],
          removed: [],
        },
      };
    };
    const sessionId = await f.bound(),
      first = await f.observed(sessionId);
    const input = (observation: Record<string, unknown>, actionId: string) => ({
      sessionId,
      actionId,
      observationId: observation.observationId,
      stateVersion: observation.stateVersion,
      ref: "element-token",
      action: { type: "setValue", value: "new" },
    });
    expect(value(await f.host.run("computer.act", input(first, "first"), "owner"))).toHaveProperty(
      "status",
      "dispatched_unverified",
    );
    const next = await f.observed(sessionId);
    expect(next.elements).toEqual([]);
    expect(next.delta).toMatchObject({ mode: "delta", baseVersion: 1, version: 2 });
    expect(f.calls.filter((call) => call.method === "observe").at(-1)?.params).toMatchObject({
      baseVersion: 1,
      full: false,
    });
    expect(
      value(await f.host.run("computer.act", input(next, "unchanged-ref"), "owner")),
    ).toHaveProperty("status", "dispatched_unverified");
    const reset = value(
      await f.host.run("computer.observe", { sessionId, full: true, baseVersion: 0 }, "owner"),
    );
    expect(reset.elements).toHaveLength(1);
    expect(reset.delta).toMatchObject({ mode: "full", baseVersion: null, version: 3 });
    f.setHelper(43, "new-helper");
    await f.host.run("computer.status", {}, "owner");
    const fresh = await f.bound();
    await f.observed(fresh);
    expect(f.calls.filter((call) => call.method === "observe").at(-1)?.params).not.toHaveProperty(
      "baseVersion",
    );
  });

  it("permits a fresh partial window observation only for an explicitly supported binding", async () => {
    const f = await fixture(),
      original = f.native.call.bind(f.native);
    f.native.call = async (method, params) => {
      const reply = await original(method, params);
      return method === "observe" && isRecord(reply) ? { ...reply, complete: false } : reply;
    };
    const legacy = await f.act(await f.bound());
    expect(await f.host.run("computer.act", legacy, "owner")).toMatchObject({
      ok: false,
      error: { code: "stale_observation" },
    });
    f.windowDirected();
    const modern = await f.act(await f.bound(), "partial-window");
    expect(value(await f.host.run("computer.act", modern, "owner"))).toHaveProperty(
      "status",
      "dispatched_unverified",
    );
  });

  it("does not authorize a removed ref after merging a valid delta", async () => {
    const f = await fixture();
    f.windowDirected();
    const original = f.native.call.bind(f.native);
    let version = 0;
    f.native.call = async (method, params) => {
      const reply = await original(method, params);
      if (method !== "observe" || !isRecord(reply)) return reply;
      version++;
      return {
        ...reply,
        stateVersion: version,
        elements: version === 1 ? [{ ref: "element-token" }] : [],
        delta: {
          mode: version === 1 ? "full" : "delta",
          lineageId: "lineage",
          baseVersion: version === 1 ? null : version - 1,
          version,
          complete: true,
          added: version === 1 ? ["element-token"] : [],
          changed: [],
          removed: version === 1 ? [] : ["element-token"],
        },
      };
    };
    const sessionId = await f.bound();
    await f.observed(sessionId);
    const removed = await f.observed(sessionId);
    expect(
      await f.host.run(
        "computer.act",
        {
          sessionId,
          actionId: "removed",
          observationId: removed.observationId,
          stateVersion: removed.stateVersion,
          ref: "element-token",
          action: { type: "setValue", value: "new" },
        },
        "owner",
      ),
    ).toMatchObject({ ok: false, error: { code: "stale_observation" } });
    expect(f.calls.some((call) => call.method === "act")).toBe(false);
  });

  it("keeps independent window lineages for the same caller", async () => {
    const f = await fixture();
    f.windowDirected();
    const original = f.native.call.bind(f.native),
      versions = new Map<string, number>();
    f.native.call = async (method, params) => {
      const reply = await original(method, params);
      if (method !== "observe" || !isRecord(reply)) return reply;
      const id = String(params.sessionId),
        version = (versions.get(id) ?? 0) + 1;
      versions.set(id, version);
      return {
        ...reply,
        stateVersion: version,
        elements: version === 1 ? [{ ref: "same-ref", value: id }] : [],
        delta: {
          mode: version === 1 ? "full" : "delta",
          lineageId: id,
          baseVersion: version === 1 ? null : version - 1,
          version,
          complete: true,
          added: version === 1 ? ["same-ref"] : [],
          changed: [],
          removed: [],
        },
      };
    };
    const a = String(
      value(await f.host.run("computer.bind", { windowRef: "window-a" }, "owner")).sessionId,
    );
    const b = String(
      value(await f.host.run("computer.bind", { windowRef: "window-b" }, "owner")).sessionId,
    );
    const firstA = await f.observed(a),
      firstB = await f.observed(b);
    expect(firstA.elements).not.toEqual(firstB.elements);
    const nextA = await f.observed(a),
      nextB = await f.observed(b);
    for (const [sessionId, observation] of [
      [a, nextA],
      [b, nextB],
    ] as const) {
      expect(observation.elements).toEqual([]);
      expect(
        value(
          await f.host.run(
            "computer.act",
            {
              sessionId,
              actionId: `action-${sessionId}`,
              observationId: observation.observationId,
              stateVersion: observation.stateVersion,
              ref: "same-ref",
              action: { type: "setValue", value: "new" },
            },
            "owner",
          ),
        ),
      ).toHaveProperty("status", "dispatched_unverified");
    }
    expect(
      f.calls
        .filter((call) => call.method === "observe")
        .slice(-2)
        .map((call) => call.params.baseVersion),
    ).toEqual([1, 1]);
  });

  it("invalidates action authority when a delta cannot be merged and permits an explicit full recovery", async () => {
    const f = await fixture();
    f.windowDirected();
    const original = f.native.call.bind(f.native);
    let reads = 0;
    f.native.call = async (method, params) => {
      const reply = await original(method, params);
      if (method !== "observe" || !isRecord(reply)) return reply;
      reads++;
      const broken = reads === 2,
        version = broken ? 1 : reads;
      return {
        ...reply,
        stateVersion: version,
        elements: broken ? [] : [{ ref: "element-token" }],
        delta: {
          mode: broken ? "delta" : "full",
          lineageId: "lineage",
          baseVersion: broken ? 0 : null,
          version,
          complete: true,
          added: broken ? [] : ["element-token"],
          changed: [],
          removed: [],
        },
      };
    };
    const sessionId = await f.bound(),
      first = await f.act(sessionId);
    expect(await f.host.run("computer.observe", { sessionId }, "owner")).toMatchObject({
      ok: false,
      error: { code: "computer_state_baseline_missing" },
    });
    expect(await f.host.run("computer.act", first, "owner")).toMatchObject({
      ok: false,
      error: { code: "stale_observation" },
    });
    const recovered = value(
      await f.host.run("computer.observe", { sessionId, full: true }, "owner"),
    );
    expect(
      value(
        await f.host.run(
          "computer.act",
          {
            ...first,
            actionId: "recovered",
            observationId: recovered.observationId,
            stateVersion: recovered.stateVersion,
          },
          "owner",
        ),
      ),
    ).toHaveProperty("status", "dispatched_unverified");
  });

  it.each([
    { actions: ["setValue", "setValue"] },
    { actions: Array.from({ length: 33 }, (_, index) => `action-${index}`) },
    { actions: ["setValue"], maxValueLength: -1 },
    { actions: ["setValue"], maxTextLength: "4096" },
  ])("rejects malformed capability constraints and closes the native binding: %j", async (capabilities) => {
    const f = await fixture();
    f.setCapabilities(capabilities);
    expect(await f.host.run("computer.bind", { windowRef: "window-token" }, "owner")).toMatchObject(
      { ok: false, error: { code: "invalid_helper_response" } },
    );
    expect(f.calls.filter((call) => call.method === "cancel")).toHaveLength(1);
    expect(f.calls.some((call) => call.method === "act")).toBe(false);
  });

  it("reclaims leased slots only after native stop confirmation and keeps their action receipts", async () => {
    const f = await fixture();
    f.enableLease();
    let confirmed: string | undefined;
    f.setStopStatus(async ({ sessionId }) => ({
      sessionId: sessionId === confirmed ? sessionId : "unrelated-session",
      stopConfirmed: true,
      terminalCause: "expired",
    }));
    const args = { windowRef: "window-token", lease: true };
    const ids = [];
    for (let index = 0; index < 128; index++)
      ids.push(String(value(await f.host.run("computer.bind", args, "owner")).sessionId));
    const [expired, renewed] = ids;
    const action = await f.act(expired);
    expect((await f.host.run("computer.act", action, "owner")).ok).toBe(true);
    const verification = await f.host.run(
      "computer.verify",
      { sessionId: expired, actionId: action.actionId },
      "owner",
    );
    expect(verification.ok).toBe(true);
    f.advance(10_000);
    expect((await f.host.run("computer.renew", { sessionId: renewed }, "owner")).ok).toBe(true);
    f.advance(21_000);

    expect(await f.host.run("computer.bind", args, "owner")).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    const statusRequests = () => f.calls.filter(({ method }) => method === "stop_status");
    expect(statusRequests().map(({ params }) => params.sessionId)).toHaveLength(127);
    expect(statusRequests().some(({ params }) => params.sessionId === renewed)).toBe(false);

    confirmed = expired;
    const fresh = value(await f.host.run("computer.bind", args, "owner"));
    expect(fresh.sessionId).not.toBe(expired);
    expect(await f.host.run("computer.observe", { sessionId: expired }, "owner")).toMatchObject({
      ok: false,
      error: { code: "unknown_session" },
    });
    const readCount = statusRequests().length;
    expect(
      value(await f.host.run("computer.recover", { actionId: action.actionId }, "owner")),
    ).toMatchObject({
      effectVerified: true,
      stopConfirmed: true,
      terminalCause: "expired",
    });
    expect(statusRequests()).toHaveLength(readCount);
    expect((await f.host.run("computer.observe", { sessionId: renewed }, "owner")).ok).toBe(true);
    expect(f.calls.filter(({ method }) => method === "act")).toHaveLength(1);
    expect(f.calls.some(({ method }) => method === "cancel")).toBe(false);
  });

  it("keeps live sessions after observation TTL and honors a shorter native binding deadline", async () => {
    const f = await fixture();
    const original = f.native.call.bind(f.native);
    f.native.call = async (method, params) => {
      const result = await original(method, params);
      return method === "bind" && isRecord(result)
        ? { ...result, expiresAt: f.options.now() / 1000 + 20 }
        : result;
    };
    for (let index = 0; index < 128; index++) await f.bound();
    f.advance(15_001);
    expect(await f.host.run("computer.bind", { windowRef: "window-token" }, "owner")).toMatchObject(
      {
        ok: false,
        error: { code: "busy" },
      },
    );
    expect(f.calls.some((c) => c.method === "cancel")).toBe(false);
    f.advance(5_000);
    await f.bound();
    expect(f.calls.filter((c) => c.method === "cancel")).toHaveLength(128);
  });

  it("reserves admission while concurrent binds wait for expired-session cleanup", async () => {
    const f = await fixture();
    for (let index = 0; index < 128; index++) await f.bound();
    f.advance(600_001);
    const replies = await Promise.all(
      Array.from({ length: 130 }, () =>
        f.host.run("computer.bind", { windowRef: "window-token" }, "owner"),
      ),
    );
    expect(replies.filter((r) => r.ok)).toHaveLength(128);
    expect(replies.filter((r) => !r.ok)).toHaveLength(2);
    expect(f.calls.filter((c) => c.method === "cancel")).toHaveLength(128);
  });

  it.each([
    "instanceId",
    "pid",
  ])("invalidates old sessions after helper %s changes and allows a fresh binding", async (identity) => {
    const f = await fixture();
    if (identity === "pid") f.setHelper(42);
    const old = await f.act(await f.bound());
    f.setHelper(identity === "pid" ? 43 : 42, identity === "pid" ? undefined : "helper-two");
    expect(await f.host.run("computer.act", old, "owner")).toMatchObject({
      ok: false,
      error: {
        code: "session_stopped",
        details: { effectStatus: "not_dispatched", terminalCause: "helper_restarted" },
      },
    });
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(0);
    expect(
      value(await f.host.run("computer.cancel", { sessionId: old.sessionId }, "owner")),
    ).toMatchObject({ status: "helper_restarted", effectVerified: false });
    expect(f.calls.filter((call) => call.method === "cancel")).toHaveLength(0);
    const fresh = await f.act(await f.bound(), "fresh-decision");
    expect(value(await f.host.run("computer.act", fresh, "owner"))).toMatchObject({
      status: "dispatched_unverified",
    });
  });

  it("rejects an old helper's observation after a new instance is verified", async () => {
    const f = await fixture();
    const sessionId = await f.bound();
    const original = f.native.call.bind(f.native);
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.native.call = async (method, params) => {
      const result = await original(method, params);
      if (method === "observe") {
        started();
        await gate;
      }
      return result;
    };
    const observing = f.host.run("computer.observe", { sessionId }, "owner");
    await began;
    f.setHelper(43, "helper-two");
    expect(value(await f.host.run("computer.status", {}, "owner")).pid).toBe(43);
    resume();
    expect(await observing).toMatchObject({ ok: false, error: { code: "session_stopped" } });
  });

  it("does not adopt a binding whose reply belongs to the previous helper", async () => {
    const f = await fixture();
    const original = f.native.call.bind(f.native);
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.native.call = async (method, params) => {
      const result = await original(method, params);
      if (method === "bind") {
        started();
        await gate;
      }
      return result;
    };
    const binding = f.host.run("computer.bind", { windowRef: "window-token" }, "owner");
    await began;
    f.setHelper(43, "helper-two");
    await f.host.run("computer.status", {}, "owner");
    resume();
    expect(await binding).toMatchObject({ ok: false, error: { code: "computer_host_stopped" } });
  });

  it("cannot promote a late action from the previous helper to a live receipt", async () => {
    const f = await fixture();
    const args = await f.act(await f.bound());
    let complete!: (value: unknown) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setDispatch(async () => {
      started();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const acting = f.host.run("computer.act", args, "owner");
    await began;
    f.setHelper(43, "helper-two");
    await f.host.run("computer.status", {}, "owner");
    complete({ status: "dispatched_unverified", effectVerified: false, eventsPosted: 1 });
    expect(value(await acting)).toMatchObject({
      status: "helper_restarted",
      terminalCause: "helper_restarted",
      effectVerified: false,
    });
    expect(
      value(
        await f.host.run(
          "computer.verify",
          {
            sessionId: args.sessionId,
            actionId: args.actionId,
          },
          "owner",
        ),
      ),
    ).toMatchObject({ status: "helper_restarted", effectVerified: false });
    expect(f.calls.filter((call) => call.method === "verify")).toHaveLength(0);
  });

  it("keeps cancellation independent of a pending helper identity check", async () => {
    const f = await fixture();
    const args = await f.act(await f.bound());
    const original = f.native.call.bind(f.native);
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.native.call = async (method, params) => {
      const result = await original(method, params);
      if (method === "hello") {
        started();
        await gate;
      }
      return result;
    };
    const acting = f.host.run("computer.act", args, "owner");
    await began;
    expect(
      value(await f.host.run("computer.cancel", { sessionId: args.sessionId }, "owner")),
    ).toMatchObject({ status: "cancelled" });
    resume();
    expect(await acting).toMatchObject({ ok: false, error: { code: "session_stopped" } });
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(0);
  });

  it("does not let a late lost reply from an exited helper block its replacement's lane", async () => {
    const f = await fixture();
    const old = await f.act(await f.bound());
    let fail!: (error: unknown) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setDispatch(async () => {
      started();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });
    const acting = f.host.run("computer.act", old, "owner");
    await began;
    f.setHelper(43, "helper-two");
    const fresh = await f.act(await f.bound(), "replacement-decision");
    fail(
      new ComputerUseError("helper_connection_lost", "Old reply lost", { effectStatus: "unknown" }),
    );
    expect(await acting).toMatchObject({ ok: false, error: { code: "unknown_outcome" } });
    f.setDispatch(async () => ({ status: "dispatched_unverified", effectVerified: false }));
    expect(value(await f.host.run("computer.act", fresh, "owner"))).toMatchObject({
      status: "dispatched_unverified",
    });
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(2);
  });

  it("reports that input was not dispatched when the read-only identity check times out", async () => {
    const f = await fixture();
    const args = await f.act(await f.bound());
    const original = f.native.call.bind(f.native);
    f.native.call = async (method, params) => {
      if (method === "hello")
        throw new ComputerUseError("helper_timeout", "Status reply lost", {
          effectStatus: "unknown",
        });
      return original(method, params);
    };
    expect(await f.host.run("computer.act", args, "owner")).toMatchObject({
      ok: false,
      error: { code: "helper_timeout", details: { effectStatus: "not_dispatched" } },
    });
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(0);
    expect(await readdir(f.stateDir)).not.toContain("ledger");
  });

  it("preserves an unknown action across helper recovery and refuses the same actionId", async () => {
    const f = await fixture();
    const old = await f.act(await f.bound());
    f.setDispatch(async () => {
      throw new ComputerUseError("helper_connection_lost", "Lost reply", {
        effectStatus: "unknown",
      });
    });
    expect(await f.host.run("computer.act", old, "owner")).toMatchObject({
      ok: false,
      error: { code: "unknown_outcome" },
    });
    f.setHelper(43, "helper-two");
    const freshSession = await f.bound();
    expect(
      value(
        await f.host.run(
          "computer.verify",
          {
            sessionId: old.sessionId,
            actionId: old.actionId,
          },
          "owner",
        ),
      ),
    ).toMatchObject({ status: "unknown", effectVerified: false });
    const fresh = await f.act(freshSession, old.actionId);
    expect(await f.host.run("computer.act", fresh, "owner")).toMatchObject({
      ok: false,
      error: { code: "duplicate_action" },
    });
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(1);
    f.setDispatch(async () => ({ status: "dispatched_unverified", effectVerified: false }));
    expect(
      value(await f.host.run("computer.act", await f.act(freshSession, "new-decision"), "owner")),
    ).toMatchObject({ status: "dispatched_unverified" });
  });

  it("dispatches advertised window actions with optional AX refs and keeps postconditions private", async () => {
    const f = await fixture();
    f.windowDirected();
    const sessionId = await f.bound();
    const inputs = [
      { type: "move", x: 10, y: 20 },
      { type: "click", x: 10, y: 20, button: "right", clickCount: 2 },
      { type: "drag", x: 10, y: 20, toX: 30, toY: 40, durationMs: 500 },
      { type: "scroll", x: 10, y: 20, deltaY: 100 },
      { type: "key", key: "A", modifiers: ["command"] },
      { type: "type", text: "Unicode 中文 😀" },
    ];
    for (const [index, action] of inputs.entries()) {
      const observation = await f.observed(sessionId);
      expect(
        value(
          await f.host.run(
            "computer.act",
            {
              sessionId,
              actionId: `window-${index}`,
              observationId: observation.observationId,
              stateVersion: observation.stateVersion,
              action,
              expect: { identifier: "result", value: "PRIVATE_EXPECTATION" },
            },
            "owner",
          ),
        ).status,
      ).toBe("dispatched_unverified");
    }
    const files = await readdir(join(f.stateDir, "ledger"));
    const records = await Promise.all(
      files.map((file) => readFile(join(f.stateDir, "ledger", file), "utf8")),
    );
    expect(records.join("")).not.toContain("PRIVATE_EXPECTATION");
    expect(records.join("")).not.toContain("Unicode 中文");
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(inputs.length);
  });

  it("passes structured refusal diagnostics through the host and typed client", async () => {
    const f = await fixture();
    f.native.call = async () => {
      throw new ComputerUseError("geometry_changed", "Observe again.", {
        effectStatus: "not_dispatched",
        stage: "before_capture",
        frames: { before: [1, 2, 3, 4] },
      });
    };
    expect(await f.host.run("computer.status", {}, "owner")).toMatchObject({
      ok: false,
      error: {
        code: "geometry_changed",
        details: {
          effectStatus: "not_dispatched",
          stage: "before_capture",
          frames: { before: [1, 2, 3, 4] },
        },
      },
    });
  });
  it("advertises automatic navigation only on full-input windows of a capable helper", async () => {
    const f = await fixture();
    const call = f.native.call.bind(f.native);
    let supported = false;
    f.native.call = async (method, params) => {
      if (method === "windows")
        return {
          windows: ["background_application", "window_semantics"].map((inputIsolation) => ({
            windowRef: inputIsolation,
            capabilities: { inputIsolation },
          })),
        };
      const reply = await call(method, params);
      if (
        method === "hello" &&
        isRecord(reply) &&
        isRecord(reply.capabilities) &&
        isRecord(reply.capabilities.background)
      ) {
        reply.capabilities.background.foregroundNavigationFallback = supported;
      }
      return reply;
    };
    for (supported of [false, true]) {
      const [full, restricted] = value(await f.host.run("computer.windows", {}, "owner"))
        .windows as Array<{ capabilities?: unknown }>;
      expect(
        isRecord(full.capabilities) && full.capabilities.foregroundNavigationFallback === true,
      ).toBe(supported);
      expect(restricted.capabilities).not.toHaveProperty("foregroundNavigationFallback");
    }
  });

  it("describes capability without starting a helper, and never starts one on unsupported platforms", async () => {
    const f = await fixture();
    expect(await f.host.describe()).toMatchObject({
      prefix: "computer",
      personal: true,
      version: 1,
    });
    expect(await f.host.status()).toMatchObject({ configured: true });
    expect(f.calls).toHaveLength(0);
    const host = createComputerUseHost({ ...f.options, platform: "linux" });
    expect(await host.run("computer.windows", {}, "owner")).toMatchObject({
      ok: false,
      error: { code: "unsupported_platform" },
    });
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    true,
    false,
  ])("reports a stopped stale binding only for a matching native receipt (%s)", async (matches) => {
    const f = await fixture();
    f.enableLease();
    f.setStopStatus(async ({ sessionId }) => ({
      sessionId: matches ? sessionId : "other-session",
      terminalCause: "lease_expired",
      stopConfirmed: true,
    }));
    const bind = () =>
      f.host.run("computer.bind", { windowRef: "window-token", lease: true }, "owner");
    const sessionId = String(value(await bind()).sessionId);
    const expired = await f.act(sessionId);
    f.advance(15_001);
    expect(await f.host.run("computer.act", expired, "owner")).toMatchObject({
      ok: false,
      error: { code: "stale_observation", details: { effectStatus: "not_dispatched" } },
    });
    expect(f.calls.some(({ method }) => method === "stop_status")).toBe(false);

    f.advance(15_000);
    const result = await f.host.run("computer.act", expired, "owner");
    expect(result).toMatchObject({ ok: false, error: { code: "stale_observation" } });
    expect(!result.ok && result.error.details).toEqual({
      effectStatus: "not_dispatched",
      ...(matches ? { terminalCause: "lease_expired", stopConfirmed: true } : {}),
    });
    expect(f.calls.filter(({ method }) => method === "stop_status")).toEqual([
      { method: "stop_status", params: { sessionId } },
    ]);
    expect(f.calls.some(({ method }) => ["act", "cancel", "end"].includes(method))).toBe(false);

    if (matches) {
      expect(await f.host.run("computer.observe", { sessionId }, "owner")).toMatchObject({
        ok: false,
        error: { code: "session_stopped" },
      });
      const next = String(value(await bind()).sessionId);
      expect(next).not.toBe(sessionId);
      expect(
        (await f.host.run("computer.act", await f.act(next, "fresh-action"), "owner")).ok,
      ).toBe(true);
      expect(f.calls.filter(({ method }) => method === "act")).toHaveLength(1);
    } else {
      expect((await f.host.run("computer.renew", { sessionId }, "owner")).ok).toBe(true);
    }
  });

  it("confirms an expired renewal without sending input or requesting a stop", async () => {
    const f = await fixture();
    f.enableLease();
    f.setStopStatus(async ({ sessionId }) => ({
      sessionId,
      terminalCause: "expired",
      stopConfirmed: true,
    }));
    const original = f.native.call.bind(f.native);
    f.native.call = async (method, params) => {
      if (method === "renew")
        throw new ComputerUseError("session_stopped", "The lease stopped.", {
          terminalCause: "expired",
        });
      return original(method, params);
    };
    const args = { windowRef: "window-token", lease: true };
    const sessionId = String(value(await f.host.run("computer.bind", args, "owner")).sessionId);
    f.advance(30_001);
    expect(await f.host.run("computer.renew", { sessionId }, "owner")).toMatchObject({
      ok: false,
      error: {
        code: "session_stopped",
        details: { terminalCause: "expired", stopConfirmed: true },
      },
    });
    expect(f.calls.filter(({ method }) => method === "stop_status")).toEqual([
      { method: "stop_status", params: { sessionId } },
    ]);
    expect(f.calls.some(({ method }) => ["act", "cancel", "end"].includes(method))).toBe(false);
  });

  it("does not replace a newer observation with an older response that arrives late", async () => {
    const f = await fixture();
    const sessionId = await f.bound();
    const original = f.native.call.bind(f.native);
    let seen = false;
    let resume!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.native.call = async (method, params) => {
      const result = await original(method, params);
      if (method === "observe" && !seen) {
        seen = true;
        started();
        await gate;
      }
      return result;
    };
    const old = f.host.run("computer.observe", { sessionId }, "owner");
    await began;
    const fresh = await f.observed(sessionId);
    resume();
    expect(await old).toMatchObject({ ok: false, error: { code: "superseded_observation" } });
    expect(
      value(
        await f.host.run(
          "computer.act",
          {
            sessionId,
            actionId: "new-decision",
            observationId: fresh.observationId,
            stateVersion: fresh.stateVersion,
            ref: "element-token",
            action: { type: "setValue", value: "ok" },
          },
          "owner",
        ),
      ),
    ).toMatchObject({ status: "dispatched_unverified" });
  });

  it("syncs an intent before dispatch, redacts content, and refuses replay after a host restart", async () => {
    const f = await fixture();
    const args = await f.act(await f.bound());
    f.setDispatch(async () => {
      const files = await readdir(join(f.stateDir, "ledger"));
      expect(files.length).toBeGreaterThan(0);
      const saved = (
        await Promise.all(files.map((file) => readFile(join(f.stateDir, "ledger", file), "utf8")))
      ).join("\n");
      expect(saved).toContain('"valueBytes":18');
      expect(saved).not.toContain("private draft text");
      return {
        status: "dispatched_unverified",
        effectVerified: false,
        eventsPosted: 0,
        operationsDispatched: 1,
      };
    });
    expect(value(await f.host.run("computer.act", args, "owner"))).toMatchObject({
      status: "dispatched_unverified",
      effectVerified: false,
    });
    expect(
      value(
        await f.host.run(
          "computer.verify",
          { sessionId: args.sessionId, actionId: args.actionId },
          "owner",
        ),
      ),
    ).toMatchObject({ status: "verified", effectVerified: true });
    expect(await f.host.run("computer.act", args, "owner")).toMatchObject({
      ok: false,
      error: { code: "duplicate_action" },
    });
    const next = createComputerUseHost(f.options);
    const sessionId = String(
      value(await next.run("computer.bind", { windowRef: "window-token" }, "owner")).sessionId,
    );
    const observation = value(await next.run("computer.observe", { sessionId }, "owner"));
    expect(
      await next.run(
        "computer.act",
        {
          ...args,
          sessionId,
          observationId: observation.observationId,
          stateVersion: observation.stateVersion,
        },
        "owner",
      ),
    ).toMatchObject({ ok: false, error: { code: "duplicate_action" } });
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(1);
  });

  it("refuses input when the intent directory is not private", async () => {
    const f = await fixture();
    const args = await f.act(await f.bound());
    const ledger = new ComputerUseLedger(join(f.stateDir, "ledger"));
    await ledger.terminal("a-safe-session", "cancelled");
    await chmod(join(f.stateDir, "ledger"), 0o777);
    expect(await f.host.run("computer.act", args, "owner")).toMatchObject({
      ok: false,
      error: { code: "unsafe_state_directory" },
    });
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(0);
  });

  it("keeps cancel independent of an in-flight action and never verifies a late result", async () => {
    const f = await fixture();
    const args = await f.act(await f.bound());
    let complete!: (value: unknown) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setDispatch(async () => {
      started();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    f.setCancellation(async () => ({ status: "takeover", terminalCause: "takeover" }));
    const acting = f.host.run("computer.act", args, "owner");
    await began;
    expect(
      value(await f.host.run("computer.cancel", { sessionId: args.sessionId }, "owner")),
    ).toMatchObject({ status: "takeover", terminalCause: "takeover" });
    complete({
      status: "dispatched_unverified",
      effectVerified: false,
      eventsPosted: 0,
      operationsDispatched: 1,
    });
    expect(value(await acting)).toMatchObject({ status: "takeover", effectVerified: false });
    expect(
      value(
        await f.host.run(
          "computer.verify",
          { sessionId: args.sessionId, actionId: args.actionId },
          "owner",
        ),
      ),
    ).toMatchObject({ status: "takeover", effectVerified: false });
    expect(f.calls.filter((call) => call.method === "verify")).toHaveLength(0);
  });

  it("preserves an unknown outcome and holds the lane until native reports idle", async () => {
    const f = await fixture();
    const args = await f.act(await f.bound());
    f.setBusy(true);
    f.setDispatch(async () => {
      throw new ComputerUseError("helper_timeout", "Reply lost.", { effectStatus: "unknown" });
    });
    expect(await f.host.run("computer.act", args, "owner")).toMatchObject({
      ok: false,
      error: { code: "unknown_outcome" },
    });
    expect(f.calls).toContainEqual({
      method: "cancel",
      params: { sessionId: args.sessionId, reason: "host_stopped" },
    });
    expect(
      value(
        await f.host.run(
          "computer.verify",
          { sessionId: args.sessionId, actionId: args.actionId },
          "owner",
        ),
      ),
    ).toMatchObject({ status: "unknown", effectVerified: false });
    const next = await f.act(await f.bound(), "action-2");
    expect(await f.host.run("computer.act", next, "owner")).toMatchObject({
      ok: false,
      error: { code: "computer_lane_unknown" },
    });
    await f.host.run("computer.status", {}, "owner");
    expect(await f.host.run("computer.act", next, "owner")).toMatchObject({
      ok: false,
      error: { code: "computer_lane_unknown" },
    });
    f.setBusy(false);
    f.setDispatch(async () => ({ status: "dispatched_unverified", effectVerified: false }));
    await f.host.run("computer.status", {}, "owner");
    expect(value(await f.host.run("computer.act", next, "owner")).status).toBe(
      "dispatched_unverified",
    );
    expect(
      await f.host.run("computer.observe", { sessionId: args.sessionId }, "owner"),
    ).toMatchObject({ ok: false, error: { code: "session_stopped" } });
  });

  it("uses binary screenshots tied to the observation and never copies the base64 into metadata", async () => {
    const f = await fixture();
    const sessionId = await f.bound();
    expect(
      await f.host.run("computer.observe", { sessionId, screenshot: true }, "owner"),
    ).toMatchObject({ ok: false, error: { code: "binary_transport_required" } });
    const { response, body } = await f.host.runBinary(
      "computer.observe",
      { sessionId, screenshot: true },
      new Uint8Array(),
      "owner",
    );
    const observation = value(response);
    expect(body.byteLength).toBe(68);
    expect(observation.screenshot).toMatchObject({
      mimeType: "image/png",
      byteLength: 68,
      width: 1,
      height: 1,
    });
    expect(observation.screenshot).not.toHaveProperty("data");
  });

  it("rejects PNG metadata that differs from IHDR and images exceeding the pixel budget", async () => {
    const f = await fixture();
    const sessionId = await f.bound();
    const original = f.native.call.bind(f.native);
    let large = false;
    f.native.call = async (method, params) => {
      const value = await original(method, params);
      if (method === "observe" && isRecord(value) && isRecord(value.screenshot)) {
        value.screenshot.width = large ? 8192 : 2;
        if (large) {
          value.screenshot.height = 4096;
          const data = Buffer.from(String(value.screenshot.data), "base64");
          data.writeUInt32BE(8192, 16);
          data.writeUInt32BE(4096, 20);
          value.screenshot.data = data.toString("base64");
        }
      }
      return value;
    };
    for (const oversized of [false, true]) {
      large = oversized;
      const output = await f.host.runBinary(
        "computer.observe",
        { sessionId, screenshot: true },
        new Uint8Array(),
        "owner",
      );
      expect(output.response).toMatchObject({
        ok: false,
        error: { code: "invalid_helper_response" },
      });
      expect(output.body.byteLength).toBe(0);
    }
  });

  it("stops only the sessions this host owns and permits a new binding after reconnection", async () => {
    const f = await fixture();
    const owned = await f.bound();
    const other = createComputerUseHost(f.options);
    const elsewhere = String(
      value(await other.run("computer.bind", { windowRef: "window-token" }, "owner")).sessionId,
    );
    f.host.disconnect();
    expect(
      f.calls.filter((call) => call.method === "cancel").map((call) => call.params.sessionId),
    ).toEqual([owned]);
    expect(await f.host.run("computer.observe", { sessionId: owned }, "owner")).toMatchObject({
      ok: false,
      error: { code: "session_stopped" },
    });
    const fresh = await f.bound();
    expect(fresh).not.toBe(owned);
    expect(
      value(await f.host.run("computer.observe", { sessionId: fresh }, "owner")),
    ).toHaveProperty("observationId");
    expect(
      value(await other.run("computer.observe", { sessionId: elsewhere }, "owner")),
    ).toHaveProperty("observationId");
  });
});
