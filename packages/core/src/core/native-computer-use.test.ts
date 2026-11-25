import { createHash } from "node:crypto";
import { describe, expect, it, rs } from "@rstest/core";
import type { ActionResponse, BinaryActionResult } from "@rome-os/node-core";
import type { ComputerUseHost } from "@rome-os/node-core/computer-use";
import type { TurnFacts } from "../agent/index.js";
import { createNativeComputerUseService } from "./native-computer-use.js";

const turn = (overrides: Partial<TurnFacts> = {}): TurnFacts => ({
  agentName: "core:main",
  continuityKey: "chat",
  sessionId: "agent-session",
  isSubagent: false,
  actions: ["core:computer_use"],
  widgets: "plain_text",
  turnId: () => "turn",
  live: () => true,
  threadContext: () => undefined,
  sharedContext: () => undefined,
  pushLevel: () => undefined,
  actor: () => ({ kind: "guardian", userId: "guardian" }),
  audience: () => "private",
  reportedTask: () => undefined,
  inTurn: (fn) => fn(),
  ...overrides,
});
const ok = (result: unknown): ActionResponse => ({ type: "response", ok: true, result });
const remoteError = (code: string, details?: Record<string, unknown>): ActionResponse => ({
  type: "response",
  ok: false,
  error: { code, message: code, details },
});
const content = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(result.content[0].text!);
const observed = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "native-session",
  observationId: "observation",
  stateVersion: 1,
  validity: { observedAt: 100, expiresAt: 115, maxAgeSeconds: 15, clock: "unix" },
  complete: true,
  elements: [],
  ...overrides,
});
const actionReceipt = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "native-session",
  actionId: "action",
  status: "dispatched_unverified",
  effectVerified: false,
  ...overrides,
});
const echoAction =
  (overrides: Record<string, unknown> = {}) =>
  async (_device: string, _action: string, args?: unknown): Promise<ActionResponse> =>
    ok(actionReceipt({ actionId: (args as { actionId?: string })?.actionId, ...overrides }));

function fixture(windowInput = false, regionalObservation = false) {
  let time = 0;
  const defaultGrant = { deviceId: "device", expiresAt: Number.MAX_SAFE_INTEGER };
  const defaultCaller = turn({ computerUseGrant: () => defaultGrant });
  const run = rs.fn(
    async (_device: string, action: string, args?: unknown): Promise<ActionResponse> => {
      if (action === "computer.observe") return ok(observed());
      if (action === "computer.act" || action === "computer.verify")
        return ok(actionReceipt({ actionId: (args as { actionId?: string }).actionId }));
      return ok(
        action === "computer.bind"
          ? {
              sessionId: "native-session",
              scope: "background",
              ...(windowInput
                ? {
                    capabilities: {
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
                      ...(regionalObservation ? { observationRegion: true } : {}),
                      maxValueLength: 16384,
                      maxTextLength: 4096,
                    },
                  }
                : {}),
            }
          : action === "computer.windows"
            ? { windows: [{ windowRef: "native-window", title: "Synthetic window" }] }
            : { status: "observed" },
      );
    },
  );
  const runBinary = rs.fn(
    async (): Promise<BinaryActionResult> => ({ response: ok({}), body: new Uint8Array() }),
  );
  const listDevices = rs.fn(async () => ({
    items: [
      { id: "device", device_name: "Mac", platform: "macos", revoked_at: null },
      { id: "revoked", device_name: "Old", platform: "macos", revoked_at: "date" },
    ],
    cursor: null,
  }));
  const client = { run, runBinary, listDevices, disconnect: rs.fn() };
  const service = createNativeComputerUseService({
    createClient: () => client as never,
    monotonicNow: () => time,
  });
  const call = (
    operation: Parameters<typeof service.run>[1],
    args: Record<string, unknown>,
    caller = defaultCaller,
  ) => service.run(caller, operation, args);
  const bind = async () => {
    const listed = await call("windows", { deviceId: "device" });
    const windowRef = JSON.parse(listed.content[0].text).result.windows[0].windowRef;
    const result = await call("bind", { deviceId: "device", windowRef });
    return JSON.parse(result.content[0].text).result.sessionId as string;
  };
  return {
    service,
    client,
    call,
    bind,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}
const act = (sessionId: string) => ({
  sessionId,
  actionId: "action",
  observationId: "observation",
  stateVersion: 1,
  ref: "field",
  action: { type: "setValue", value: "private value" },
});

const macWindow = {
  deviceId: "3e3cadea-3880-465b-811a-1c261005d3a7",
  peer: "a3df819f-ebe0-4baf-a742-4216ca01c7be",
};
const macWindowInfo = {
  platform: "macos",
  audit: { state: "ok" },
  actions: [
    "system.info",
    "computer.status",
    "computer.windows",
    "computer.bind",
    "computer.observe",
    "computer.cancel",
  ],
  frameVersion: 1,
};

function turnCleanupFixture() {
  const { deviceId } = macWindow;
  let nextId = 0;
  const actions = new Map<string, string>();
  const stopped = new Set<string>();
  const run = rs.fn(async (action: string, args: unknown): Promise<ActionResponse> => {
    const { sessionId, actionId } = args as { sessionId?: string; actionId?: string };
    if (action === "computer.windows") return ok({ windows: [{ windowRef: "window" }] });
    if (action === "computer.bind")
      return ok({
        sessionId: `binding-${++nextId}`,
        scope: "background",
        capabilities: { sessionEnd: true },
      });
    if (sessionId && (action === "computer.end" || action === "computer.cancel")) {
      stopped.add(sessionId);
      return ok({
        sessionId,
        terminalCause: action === "computer.end" ? "completed" : "cancelled",
        stopConfirmed: true,
        effectVerified: false,
      });
    }
    if (action === "computer.act" && sessionId && actionId) {
      if (actions.has(actionId)) return remoteError("duplicate_action", { sessionId, actionId });
      actions.set(actionId, sessionId);
      return ok(actionReceipt({ sessionId, actionId }));
    }
    if (action === "computer.verify" && actionId && actions.get(actionId) === sessionId)
      return ok(actionReceipt({ sessionId, actionId, status: "verified", effectVerified: true }));
    if (action === "computer.recover" && actionId) {
      const recordedSession = actions.get(actionId);
      return recordedSession
        ? ok({
            sessionId: recordedSession,
            actionId,
            status: "dispatched_unverified",
            effectVerified: true,
            verificationStatus: "verified",
            stopConfirmed: stopped.has(recordedSession),
          })
        : remoteError("unknown_action");
    }
    return ok(observed({ sessionId }));
  });
  const host: ComputerUseHost = {
    run,
    describe: async () => ({}),
    status: async () => ({}),
    requestPermissions: async () => ok({}),
    runBinary: async () => ({ response: ok({}), body: new Uint8Array() }),
    idle: async () => {},
    disconnect: rs.fn(),
  };
  const createService = () =>
    createNativeComputerUseService({ local: { deviceId, name: "Local Mac", host } });
  const service = createService();
  const expiresAt = Date.now() + 10_000;
  const caller = (turnId: string, sessionId = "agent-session") =>
    turn({ sessionId, turnId: () => turnId, computerUseGrant: () => ({ deviceId, expiresAt }) });
  const list = async (turn: TurnFacts) =>
    content(await service.run(turn, "windows", { deviceId })).result.windows[0].windowRef as string;
  const bind = async (turn: TurnFacts) => {
    const result = await service.run(turn, "bind", { deviceId, windowRef: await list(turn) });
    return content(result).result.sessionId as string;
  };
  return { service, createService, run, caller, list, bind, deviceId };
}

describe("native computer-use agent admission", () => {
  it.each([
    [true, undefined, true],
    [true, true, false],
    [false, false, false],
  ])("negotiates navigation retries for advertised=%s, backgroundOnly=%s", async (advertised, backgroundOnly, enabled) => {
    const f = fixture(true);
    f.client.run.mockResolvedValueOnce(
      ok({
        windows: [
          {
            windowRef: "native-window",
            capabilities: { foregroundNavigationFallback: advertised },
          },
        ],
      }),
    );
    const windows = content(await f.call("windows", { deviceId: "device" }));
    f.client.run.mockResolvedValueOnce(
      ok({
        sessionId: "native-session",
        scope: "background",
        capabilities: {
          actions: ["click"],
          coordinateSpace: "window_image_pixels",
          realPointer: false,
          foregroundNavigationFallback: enabled,
        },
      }),
    );
    const bound = content(
      await f.call("bind", {
        deviceId: "device",
        windowRef: windows.result.windows[0].windowRef,
        backgroundOnly,
      }),
    );
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.bind", {
      windowRef: "native-window",
      ...(enabled ? { foregroundNavigationFallback: true } : {}),
    });
    const input = { ...act(bound.result.sessionId), action: { type: "click" }, navigation: true };
    await f.call("act", input);
    const { navigation: _navigation, ...wire } = input;
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.act", {
      ...wire,
      sessionId: "native-session",
      actionId: expect.stringMatching(/^cu1-/),
      ...(enabled ? { navigation: true } : {}),
    });
  });

  it("keeps navigation routing diagnostics out of the normal agent receipt", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    f.client.run.mockImplementationOnce(
      echoAction({
        dispatchChecks: [
          { pointerTargetMatched: true, foregroundActivated: true, foregroundRetry: true },
        ],
        eventsPosted: 4,
      }),
    );
    const result = content(
      await f.call("act", { ...act(sessionId), action: { type: "click" } }),
    ).result;
    expect(result.dispatchChecks).toEqual([{ pointerTargetMatched: true }]);
    expect(result.eventsPosted).toBe(4);
  });

  it("negotiates ordinary remote Mac capabilities and AX observation without binary frames", async () => {
    const f = fixture();
    const { deviceId } = macWindow;
    const run = rs.fn(
      async (
        target: string,
        action: string,
        _args: unknown,
        auth?: unknown,
      ): Promise<ActionResponse> => {
        expect(target).toBe(deviceId);
        expect(auth).toBeUndefined();
        if (action === "system.info")
          return ok({
            ...macWindowInfo,
            frameVersion: 2,
            actions: [
              ...macWindowInfo.actions,
              "computer.end",
              "computer.renew",
              "computer.preempt",
            ],
          });
        const capabilities = {
          actions: ["setValue"],
          coordinateSpace: "window_image_pixels",
          realPointer: false,
        };
        switch (action) {
          case "computer.status":
            return ok({ capabilities: { background: capabilities } });
          case "computer.windows":
            return ok({ windows: [{ windowRef: "listed-window" }] });
          case "computer.bind":
            return ok({ sessionId: "older-binding", scope: "background", capabilities });
          case "computer.observe":
            return ok(observed({ sessionId: "older-binding" }));
          case "computer.cancel":
            return ok({ sessionId: "older-binding", terminalCause: "cancelled" });
          default:
            throw new Error("Unexpected capability call");
        }
      },
    );
    const service = createNativeComputerUseService({
      createClient: () => ({ ...f.client, run }) as never,
    });
    const grant = { deviceId, expiresAt: Date.now() + 10_000 };
    const approved = turn({ computerUseGrant: () => grant });
    expect(content(await service.run(approved, "discover", { deviceId }))).toMatchObject({
      availability: "online",
      authorizedActions: macWindowInfo.actions.slice(1),
      binaryFrames: false,
    });
    const { windowRef } = content(await service.run(approved, "windows", { deviceId })).result
      .windows[0];
    const { sessionId } = content(
      await service.run(approved, "bind", { deviceId, windowRef }),
    ).result;
    expect(
      content(await service.run(approved, "observe", { sessionId, screenshot: false })),
    ).toMatchObject({
      result: { sessionId, stateVersion: 1 },
    });
    expect(content(await service.run(approved, "cancel", { sessionId }))).toMatchObject({
      localStatus: "cancelled",
      result: { sessionId, stopConfirmed: false },
    });
    await service.close();
  });

  it.each([
    { actions: undefined },
    { audit: { state: "unavailable" } },
    { computerUse: false },
  ])("reports no authorized actions for an unavailable ordinary Mac advertisement: %o", async (patch) => {
    const f = fixture();
    const { deviceId } = macWindow;
    f.client.run.mockResolvedValue(ok({ ...macWindowInfo, ...patch }));
    const service = createNativeComputerUseService({
      createClient: () => f.client as never,
    });
    const grant = { deviceId, expiresAt: Date.now() + 10_000 };
    const approved = turn({ computerUseGrant: () => grant });
    expect(content(await service.run(approved, "discover", { deviceId }))).toMatchObject({
      availability: "online",
      authorizedActions: [],
      binaryFrames: false,
    });
    expect(f.client.run.mock.calls.map((call) => call[1])).not.toContain("computer.status");
    await service.close();
  });

  it("discovers and runs the configured local device without opening a gateway client", async () => {
    const deviceId = "ee969ec6-1944-4e85-9fd3-31ec802f8e02";
    const run = rs.fn(async (action: string) =>
      action === "computer.status"
        ? ok({
            permissions: { accessibility: true },
            capabilities: { background: { sessionEnd: true } },
          })
        : ok({ windows: [{ windowRef: "native-local-window" }] }),
    );
    const host: ComputerUseHost = {
      describe: async () => ({
        prefix: "computer",
        configured: true,
        actions: ["computer.status", "computer.windows"],
      }),
      run,
      status: async () => ({}),
      requestPermissions: async () => ok({}),
      runBinary: async () => ({ response: ok({}), body: new Uint8Array() }),
      idle: async () => {},
      disconnect: rs.fn(),
    };
    const createClient = rs.fn(() => {
      throw new Error("No Gateway in this user session");
    });
    const service = createNativeComputerUseService({
      local: { deviceId, name: "Local Mac", host },
      createClient,
    });
    const expiresAt = Date.now() + 10_000;
    let approved = true;
    const grant = { deviceId, expiresAt, isCurrent: async () => approved };
    const authorized = turn({ computerUseGrant: () => grant });
    expect(await service.run(turn(), "windows", { deviceId })).toMatchObject({ isError: true });
    expect(await service.run(authorized, "windows", { deviceId: "remote" })).toMatchObject({
      isError: true,
    });
    expect(run).not.toHaveBeenCalled();
    expect(content(await service.run(authorized, "status", {}))).toMatchObject({
      approvedDeviceId: deviceId,
      devices: [{ id: deviceId, name: "Local Mac" }],
    });
    expect(content(await service.run(authorized, "discover", { deviceId }))).toMatchObject({
      availability: "online",
      computer: { background: { sessionEnd: true } },
    });
    expect(await service.run(authorized, "windows", { deviceId })).not.toHaveProperty("isError");
    expect(createClient).not.toHaveBeenCalled();
    approved = false;
    expect(content(await service.run(authorized, "windows", { deviceId }))).toMatchObject({
      error: { code: "computer_use_denied" },
    });
    expect(content(await service.run(authorized, "status", {}))).toMatchObject({
      devices: [{ id: deviceId, name: "Local Mac" }],
    });
    expect(content(await service.run(authorized, "status", {}))).not.toHaveProperty(
      "approvedDeviceId",
    );
    expect(run.mock.calls.map((call) => call[0])).toEqual(["computer.status", "computer.windows"]);
    await service.close();
    expect(host.disconnect).toHaveBeenCalledOnce();
  });

  it("dispatches macOS preemption only for an authorized turn without extra transport auth", async () => {
    const { deviceId } = macWindow;
    const f = fixture();
    const run = rs.fn(async (_device: string, action: string, args: unknown, auth?: unknown) => {
      expect(_device).toBe(deviceId);
      if (action === "system.info")
        return ok({
          ...macWindowInfo,
          actions: [...macWindowInfo.actions, "computer.preempt"],
        });
      expect(auth).toBeUndefined();
      if (action === "computer.windows") return ok({ windows: [{ windowRef: "native-window" }] });
      if (action === "computer.bind")
        return remoteError("busy", { preemptToken: "native-generation" });
      if (action === "computer.cancel")
        return ok({ stopConfirmed: true, terminalCause: "cancelled" });
      expect(action).toBe("computer.preempt");
      expect(args).toEqual({ windowRef: "native-window", preemptToken: "native-generation" });
      return ok({
        sessionId: "replacement-native",
        preemptedSessionId: "incumbent-native",
        scope: "background",
        capabilities: {
          coordinateSpace: "window_image_pixels",
          realPointer: false,
          windowPreemption: true,
        },
        preemption: { stopConfirmed: true, terminalCause: "preempted" },
      });
    });
    const service = createNativeComputerUseService({
      createClient: () => ({ ...f.client, run }) as never,
    });
    const expiresAt = Date.now() + 10000;
    const authorized = turn({ computerUseGrant: () => ({ deviceId, expiresAt }) });
    expect((await service.run(turn(), "windows", { deviceId })).isError).toBe(true);
    expect((await service.run(authorized, "windows", { deviceId: "another-device" })).isError).toBe(
      true,
    );
    expect(run).not.toHaveBeenCalled();
    const optedIn = turn({
      computerUseGrant: () => ({ deviceId, expiresAt, allowPreemption: true }),
    });
    const { windowRef } = content(await service.run(optedIn, "windows", { deviceId })).result
      .windows[0];
    const busy = content(await service.run(optedIn, "bind", { deviceId, windowRef }));
    const preempt = { deviceId, windowRef, preemptToken: busy.error.details.preemptToken };
    expect(content(await service.run(authorized, "preempt", preempt))).toMatchObject({
      error: { code: "computer_use_denied" },
    });
    const replacement = content(await service.run(optedIn, "preempt", preempt));
    expect(replacement.result).toMatchObject({
      preemption: { stopConfirmed: true, terminalCause: "preempted" },
    });
    expect(replacement.result.sessionId).not.toBe("replacement-native");
    expect(replacement.result).not.toHaveProperty("preemptedSessionId");
    await service.close();
  });

  it("does not substitute a Rome window mentioning an unavailable application", async () => {
    const f = fixture();
    const deviceId = "device";
    const application = "飞书";
    const windows = [
      {
        windowRef: "native-rome",
        appName: "Electron",
        bundleId: "com.github.Electron",
        title: "Rome · 飞书 Workspace 对照",
      },
      { windowRef: "legacy-without-app-identity", title: "飞书" },
    ];
    f.client.run.mockResolvedValueOnce(ok({ windows }));
    const filtered = content(await f.call("windows", { deviceId, application }));
    expect(filtered).toMatchObject({ ok: true, result: { application, windows: [] } });

    f.client.run.mockResolvedValueOnce(ok({ windows }));
    const listed = content(await f.call("windows", { deviceId }));
    const { windowRef } = listed.result.windows[0];
    const result = await f.call("bind", { deviceId, application, windowRef });
    expect(result.isError).toBe(true);
    expect(content(result)).toMatchObject({ error: { code: "window_application_mismatch" } });
    expect(f.client.run.mock.calls).toEqual([
      [deviceId, "computer.windows", {}],
      [deviceId, "computer.windows", {}],
    ]);
  });

  it("lists and binds by the application's name or bundle identifier without changing the Node request", async () => {
    const f = fixture();
    const deviceId = "device";
    f.client.run.mockResolvedValueOnce(
      ok({
        windows: [
          { windowRef: "native-rome", appName: "Rome", title: "com.electron.lark" },
          {
            windowRef: "native-lark",
            appName: "飞书",
            bundleId: "com.electron.lark",
            title: "Workspace",
          },
        ],
      }),
    );
    const listed = content(
      await f.call("windows", { deviceId, application: "  COM.ELECTRON.LARK  " }),
    );
    expect(listed.result.windows).toEqual([
      {
        windowRef: expect.any(String),
        appName: "飞书",
        bundleId: "com.electron.lark",
        title: "Workspace",
      },
    ]);
    const { windowRef } = listed.result.windows[0];
    const bound = content(await f.call("bind", { deviceId, windowRef, application: "飞书" }));
    expect(bound).toMatchObject({ ok: true });
    expect(f.client.run.mock.calls).toEqual([
      [deviceId, "computer.windows", {}],
      [deviceId, "computer.bind", { windowRef: "native-lark" }],
    ]);
  });

  it.each([
    { actions: ["core:device_run"] },
    { actor: () => undefined },
    { actor: () => ({ kind: "visitor", accountId: "visitor" }) },
    { audience: () => "shared" as const },
    { live: () => false },
    { live: undefined },
  ])("refuses a non-admitted turn before creating a client: %o", async (overrides) => {
    const f = fixture();
    expect((await f.call("status", {}, turn(overrides))).isError).toBe(true);
    expect(f.client.listDevices).not.toHaveBeenCalled();
    expect(f.client.run).not.toHaveBeenCalled();
  });

  it("lists only unrevoked authorization records without probing a device", async () => {
    const f = fixture();
    const result = await f.call("status", {}, turn());
    expect(JSON.parse(result.content[0].text).devices).toEqual([
      { id: "device", name: "Mac", platform: "macos" },
    ]);
    expect(f.client.run).not.toHaveBeenCalled();
  });

  it("only allows the opted-in turn to replace the exact generation named by its busy bind", async () => {
    const f = fixture();
    const deviceId = "device";
    const grant = { deviceId, expiresAt: Date.now() + 30_000, allowPreemption: true as const };
    const authorized = turn({ computerUseGrant: () => grant });
    const ordinary = turn({ computerUseGrant: () => ({ deviceId, expiresAt: grant.expiresAt }) });
    const list = async () =>
      content(await f.call("windows", { deviceId }, authorized)).result.windows[0].windowRef;
    const held = { preemptToken: "private-native-generation", sessionId: "old-native-session" };
    const windowRef = await list();
    f.client.run.mockResolvedValueOnce(remoteError("busy", held));
    expect(content(await f.call("bind", { deviceId, windowRef }, ordinary))).toMatchObject({
      error: { code: "busy" },
    });
    const listed = await list();
    f.client.run.mockResolvedValueOnce(remoteError("busy", held));
    const busy = content(await f.call("bind", { deviceId, windowRef: listed }, authorized));
    const token = busy.error.details.preemptToken as string;
    expect(token).toBeTruthy();
    expect(token).not.toBe(held.preemptToken);
    expect(JSON.stringify(busy)).not.toContain(held.sessionId);
    const input = { deviceId, windowRef: listed, preemptToken: token };
    f.client.run.mockClear();
    expect(content(await f.call("preempt", input, ordinary))).toMatchObject({
      error: { code: "computer_use_denied" },
    });
    expect((await f.call("preempt", { ...input, deviceId: "other" }, authorized)).isError).toBe(
      true,
    );
    expect(
      (await f.call("preempt", { ...input, preemptToken: held.preemptToken }, authorized)).isError,
    ).toBe(true);
    expect(
      (
        await f.call(
          "preempt",
          input,
          turn({ computerUseGrant: () => grant, turnId: () => "next" }),
        )
      ).isError,
    ).toBe(true);
    expect(f.client.run).not.toHaveBeenCalled();
    f.client.run.mockResolvedValueOnce(
      remoteError("preemption_pending", { sessionId: held.sessionId }),
    );
    const pending = content(await f.call("preempt", input, authorized));
    expect(pending).toMatchObject({ error: { code: "preemption_pending" } });
    expect(JSON.stringify(pending)).not.toContain(held.sessionId);
    f.client.run.mockResolvedValueOnce(
      ok({
        sessionId: "native-replacement",
        scope: "background",
        capabilities: { windowPreemption: true, realPointer: false },
        preemption: { stopConfirmed: true, terminalCause: "preempted", nativeId: held.sessionId },
        preemptedSessionId: held.sessionId,
      }),
    );
    const replacement = content(await f.call("preempt", input, authorized));
    expect(replacement.ok).toBe(true);
    expect(replacement.result.sessionId).not.toBe("native-replacement");
    expect(replacement.result.preemption).toEqual({
      stopConfirmed: true,
      terminalCause: "preempted",
    });
    expect(JSON.stringify(replacement)).not.toContain(held.sessionId);
    expect((await f.call("preempt", input, authorized)).isError).toBe(true);
    expect(f.client.run.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        deviceId,
        "computer.preempt",
        { windowRef: "native-window", preemptToken: held.preemptToken },
      ]),
    );
  });

  it("invalidates the preemption token when a reply is lost and never binds another generation with it", async () => {
    const f = fixture();
    const deviceId = "device";
    const grant = { deviceId, expiresAt: Date.now() + 30_000, allowPreemption: true as const };
    const caller = turn({ computerUseGrant: () => grant });
    const { windowRef } = content(await f.call("windows", { deviceId }, caller)).result.windows[0];
    f.client.run.mockResolvedValueOnce(remoteError("busy", { preemptToken: "old-generation" }));
    const busy = content(await f.call("bind", { deviceId, windowRef }, caller));
    const input = { deviceId, windowRef, preemptToken: busy.error.details.preemptToken };
    f.client.run.mockResolvedValueOnce(remoteError("unknown_outcome"));
    expect(content(await f.call("preempt", input, caller))).toMatchObject({
      error: { code: "unknown_outcome" },
    });
    expect((await f.call("preempt", input, caller)).isError).toBe(true);
    const freshRef = content(await f.call("windows", { deviceId }, caller)).result.windows[0]
      .windowRef;
    expect((await f.call("preempt", { ...input, windowRef: freshRef }, caller)).isError).toBe(true);
    expect(f.client.run.mock.calls.map((call) => call[1])).toEqual([
      "computer.windows",
      "computer.bind",
      "computer.preempt",
      "computer.windows",
    ]);
  });

  it("reads only scoped recovery metadata and does not recreate the native session", async () => {
    const f = fixture();
    const deviceId = "device";
    const actionId = "previous-action";
    const expiresAt = Date.now() + 30_000;
    const authorized = turn({ computerUseGrant: () => ({ deviceId, expiresAt }) });
    expect((await f.call("recover", { deviceId, actionId }, turn())).isError).toBe(true);
    expect(
      (await f.call("recover", { deviceId: "other-device", actionId }, authorized)).isError,
    ).toBe(true);
    expect(f.client.run).not.toHaveBeenCalled();
    f.client.run.mockImplementationOnce(async (_device, _action, args) =>
      ok({
        status: "unknown",
        stopConfirmed: true,
        effectVerified: true,
        verificationStatus: "verified",
        actionId: (args as { actionId?: string })?.actionId,
        sessionId: "old-native-session",
        privateText: "secret",
      }),
    );
    expect(content(await f.call("recover", { deviceId, actionId }, authorized))).toEqual(
      ok({ status: "unknown", stopConfirmed: true, effectVerified: false, actionId }),
    );
    const verified = {
      status: "dispatched_unverified",
      stopConfirmed: false,
      effectVerified: true,
      verificationStatus: "verified",
      actionId,
    };
    f.client.run.mockImplementationOnce(async (_device, _action, args) =>
      ok({
        ...verified,
        actionId: (args as { actionId?: string })?.actionId,
        sessionId: "old-native-session",
      }),
    );
    expect(content(await f.call("recover", { deviceId, actionId }, authorized))).toEqual(
      ok(verified),
    );
    expect((await f.call("observe", { sessionId: "old-native-session" }, authorized)).isError).toBe(
      true,
    );
    expect(f.client.run.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        deviceId,
        "computer.recover",
        { actionId: expect.stringMatching(/^cu1-/) },
      ]),
    );
  });

  it("keeps granted action IDs separate by owner and restores them across Core restarts", async () => {
    const { service, createService, run, caller, bind, deviceId } = turnCleanupFixture();
    const first = caller("first", "agent-one");
    const second = caller("second", "agent-two");
    const sessionOne = await bind(first);
    const sessionTwo = await bind(second);
    const inputOne = { ...act(sessionOne), verifyAfter: true };
    const inputTwo = act(sessionTwo);
    const inline = content(await service.run(first, "act", inputOne));
    expect(inline).toMatchObject({
      act: { actionId: inputOne.actionId, sessionId: sessionOne },
      verify: { actionId: inputOne.actionId, sessionId: sessionOne, effectVerified: true },
    });
    expect(
      run.mock.calls.find(([operation]) => operation === "computer.act")?.[1],
    ).not.toHaveProperty("verifyAfter");
    expect(content(await service.run(second, "act", inputTwo))).toMatchObject({
      result: { sessionId: sessionTwo, actionId: inputTwo.actionId },
    });
    expect(
      content(
        await service.run(second, "verify", { sessionId: sessionTwo, actionId: inputTwo.actionId }),
      ),
    ).toMatchObject({
      result: { sessionId: sessionTwo, actionId: inputTwo.actionId, effectVerified: true },
    });
    const writes = run.mock.calls
      .filter(([operation]) => operation === "computer.act")
      .map(([, args]) => (args as { actionId: string }).actionId);
    expect(writes).toHaveLength(2);
    expect(writes.every((id) => /^cu1-[a-f0-9]{64}$/.test(id))).toBe(true);
    expect(writes[0]).not.toBe(writes[1]);
    expect(JSON.stringify(inline)).not.toContain(writes[0]);
    const duplicate = content(await service.run(first, "act", inputOne));
    expect(duplicate).toMatchObject({ error: { code: "duplicate_action", details: {} } });
    expect(JSON.stringify(duplicate)).not.toContain(writes[0]);
    await service.run(first, "end", { sessionId: sessionOne });
    await service.run(second, "end", { sessionId: sessionTwo });
    await service.close();
    const restarted = createService();
    const recover = { deviceId, actionId: inputOne.actionId };
    const ownerOne = caller("after-restart", "agent-one");
    const ownerTwo = caller("later-turn", "agent-two");
    for (const owner of [ownerOne, ownerTwo]) {
      expect(content(await restarted.run(owner, "recover", recover))).toMatchObject({
        result: { actionId: recover.actionId, effectVerified: true, stopConfirmed: true },
      });
    }
    for (const other of [
      caller("third", "agent-three"),
      { ...ownerOne, actor: () => ({ kind: "guardian" as const, userId: "other-guardian" }) },
    ]) {
      expect(content(await restarted.run(other, "recover", recover))).toMatchObject({
        error: { code: "unknown_action" },
      });
    }
    expect(
      content(await restarted.run(ownerTwo, "recover", { deviceId, actionId: writes[0] })),
    ).toMatchObject({
      error: { code: "unknown_action" },
    });
    expect(run.mock.calls.filter(([operation]) => operation === "computer.act")).toHaveLength(3);
    await restarted.close();
  });

  it("does not ask an older binding to end normally or renew a lease", async () => {
    const f = fixture();
    const sessionId = await f.bind();
    f.client.run.mockClear();
    expect(JSON.parse((await f.call("end", { sessionId })).content[0].text)).toMatchObject({
      error: { code: "session_end_unsupported" },
    });
    expect(JSON.parse((await f.call("renew", { sessionId })).content[0].text)).toMatchObject({
      error: { code: "window_lease_not_enabled" },
    });
    expect(f.client.run).not.toHaveBeenCalled();
  });

  it.each([
    true,
    false,
  ])("uses a negotiated lease when requested explicitly=%s or supplied by the host", async (explicit) => {
    const f = fixture();
    const listed = await f.call("windows", { deviceId: "device" });
    const { windowRef } = JSON.parse(listed.content[0].text).result.windows[0];
    const lease = { idleTimeoutMs: 30_000, renewAfterMs: 10_000, remainingMs: 28_000 };
    f.client.run.mockResolvedValueOnce(
      ok({
        sessionId: "native-session",
        scope: "background",
        capabilities: { sessionEnd: true, windowLease: true },
        lease,
      }),
    );
    const bound = await f.call("bind", {
      deviceId: "device",
      windowRef,
      ...(explicit ? { lease: true } : {}),
      requireSessionEnd: true,
    });
    const { sessionId } = JSON.parse(bound.content[0].text).result;
    expect(sessionId).not.toBe("native-session");
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.bind", {
      windowRef: "native-window",
      ...(explicit ? { lease: true } : {}),
      requireSessionEnd: true,
    });
    f.client.run.mockResolvedValueOnce(
      ok({ sessionId: "native-session", status: "renewed", lease }),
    );
    const renewed = await f.call("renew", { sessionId });
    expect(JSON.parse(renewed.content[0].text).result).toEqual({
      sessionId,
      status: "renewed",
      lease,
    });
    f.client.run.mockResolvedValueOnce(
      ok({
        sessionId: "native-session",
        terminalCause: "completed",
        status: "completed",
        stopConfirmed: true,
        effectVerified: false,
      }),
    );
    const stopped = await f.call("end", { sessionId });
    expect(JSON.parse(stopped.content[0].text).result).toMatchObject({
      sessionId,
      stopConfirmed: true,
    });
    expect((await f.call("renew", { sessionId })).isError).toBe(true);
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.end", {
      sessionId: "native-session",
    });
  });

  it("rejects sessions reused by a fork or another actor and rejects a device override", async () => {
    const f = fixture();
    const sessionId = await f.bind();
    const granted = (overrides: Partial<TurnFacts>) =>
      turn({
        computerUseGrant: () => ({ deviceId: "device", expiresAt: Number.MAX_SAFE_INTEGER }),
        ...overrides,
      });
    expect(sessionId).not.toBe("native-session");
    f.client.run.mockClear();
    expect(
      content(await f.call("observe", { sessionId }, granted({ sessionId: "fork" }))),
    ).toMatchObject({
      error: { code: "invalid_session" },
    });
    expect(
      content(
        await f.call(
          "observe",
          { sessionId },
          granted({ actor: () => ({ kind: "guardian", userId: "other" }) }),
        ),
      ),
    ).toMatchObject({ error: { code: "invalid_session" } });
    expect((await f.call("act", { ...act(sessionId), deviceId: "other-device" })).isError).toBe(
      true,
    );
    expect(f.client.run).not.toHaveBeenCalled();
  });

  it("binds window references to the issuing actor session, device and monotonic deadline", async () => {
    const f = fixture();
    const listed = await f.call("windows", { deviceId: "device" });
    const windowRef = JSON.parse(listed.content[0].text).result.windows[0].windowRef;
    expect(windowRef).not.toBe("native-window");
    f.client.run.mockClear();
    expect((await f.call("bind", { deviceId: "device", windowRef: "native-window" })).isError).toBe(
      true,
    );
    expect(
      content(
        await f.call(
          "bind",
          { deviceId: "device", windowRef },
          turn({
            sessionId: "fork",
            computerUseGrant: () => ({ deviceId: "device", expiresAt: Number.MAX_SAFE_INTEGER }),
          }),
        ),
      ),
    ).toMatchObject({ error: { code: "invalid_window_ref" } });
    expect((await f.call("bind", { deviceId: "other-device", windowRef })).isError).toBe(true);
    f.advance(15_000);
    expect((await f.call("bind", { deviceId: "device", windowRef })).isError).toBe(true);
    expect(f.client.run).not.toHaveBeenCalled();
  });

  it("drops a window result when another turn supersedes the call while it waits", async () => {
    const f = fixture();
    let currentTurn = "first";
    let finish: (response: ActionResponse) => void = () => {};
    const waiting = new Promise<ActionResponse>((resolve) => {
      finish = resolve;
    });
    f.client.run.mockImplementationOnce(async () => waiting);
    const listed = f.call(
      "windows",
      { deviceId: "device" },
      turn({
        turnId: () => currentTurn,
        computerUseGrant: () => ({ deviceId: "device", expiresAt: Number.MAX_SAFE_INTEGER }),
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    currentTurn = "second";
    finish(ok({ windows: [{ windowRef: "native-window" }] }));
    expect((await listed).isError).toBe(true);
  });

  it("rechecks the chat audience and cancels a late binding", async () => {
    const f = fixture();
    let privateChat = true;
    const service = createNativeComputerUseService({
      createClient: () => f.client as never,
      placeAudience: async () => (privateChat ? "private" : "shared"),
    });
    const caller = turn({
      computerUseGrant: () => ({ deviceId: "device", expiresAt: Number.MAX_SAFE_INTEGER }),
    });
    const listed = await service.run(caller, "windows", { deviceId: "device" });
    const windowRef = JSON.parse(listed.content[0].text).result.windows[0].windowRef;
    f.client.run.mockImplementationOnce(async () => {
      privateChat = false;
      return ok({ sessionId: "late" });
    });
    expect((await service.run(caller, "bind", { deviceId: "device", windowRef })).isError).toBe(
      true,
    );
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.cancel", {
      sessionId: "late",
    });
  });

  it("never replays after an unknown action, including when later evidence looks successful", async () => {
    const f = fixture();
    const sessionId = await f.bind();
    f.client.run.mockResolvedValueOnce({
      type: "response",
      ok: false,
      error: { code: "unknown_outcome", message: "lost" },
    });
    await f.call("act", act(sessionId));
    const before = f.client.run.mock.calls.length;
    expect((await f.call("act", { ...act(sessionId), actionId: "new" })).isError).toBe(true);
    expect(
      (
        await f.call("act", {
          ...act(sessionId),
          actionId: "different-value-after-unknown",
          action: { type: "setValue", value: "different value" },
        })
      ).isError,
    ).toBe(true);
    expect(f.client.run.mock.calls.length).toBe(before);
    f.client.run.mockImplementationOnce(echoAction({ status: "verified", effectVerified: true }));
    const result = JSON.parse(
      (await f.call("verify", { sessionId, actionId: "action" })).content[0].text,
    );
    expect(result).toMatchObject({
      status: "unknown",
      effectVerified: false,
      replayAllowed: false,
    });
  });

  it("keeps AX assignment explicit and rejects invalid values before dispatch", async () => {
    const f = fixture();
    const sessionId = await f.bind();
    f.client.run.mockImplementationOnce(
      echoAction({
        status: "dispatched_unverified",
        effectVerified: false,
        method: "ax_set_value",
        operationsDispatched: 1,
        eventsPosted: 0,
      }),
    );
    await f.call("act", {
      ...act(sessionId),
      actionId: "set-value",
      action: { type: "setValue", value: "" },
    });
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.act", {
      ...act("native-session"),
      actionId: expect.stringMatching(/^cu1-/),
      action: { type: "setValue", value: "" },
    });
    const before = f.client.run.mock.calls.length;
    for (const value of ["has\0nul", "😀".repeat(91)]) {
      expect(
        (
          await f.call("act", {
            ...act(sessionId),
            actionId: "invalid-value",
            action: { type: "setValue", value },
          })
        ).isError,
      ).toBe(true);
    }
    for (const action of [{ type: "press" }, { type: "type", text: "unsupported" }]) {
      expect(
        (await f.call("act", { ...act(sessionId), actionId: "unsupported", action })).isError,
      ).toBe(true);
    }
    expect(f.client.run.mock.calls.length).toBe(before);
  });

  it("does not report remote cancellation when the cancellation request cannot reach the computer", async () => {
    const f = fixture();
    const sessionId = await f.bind();
    f.client.run.mockResolvedValueOnce({
      type: "response",
      ok: false,
      error: { code: "target_unavailable", message: "offline" },
    });
    const cancelled = await f.call("cancel", { sessionId });
    expect(cancelled.isError).toBe(true);
    expect(JSON.parse(cancelled.content[0].text)).toMatchObject({
      status: "cancel_requested",
      localStatus: "cancel_requested",
    });
    const before = f.client.run.mock.calls.length;
    expect((await f.call("act", act(sessionId))).isError).toBe(true);
    expect(f.client.run.mock.calls.length).toBe(before);
  });

  it.each([
    { sessionId: "other-session" },
    { actionId: "other-action" },
  ])("closes input when a dispatch receipt belongs to another request: %o", async (identity) => {
    const f = fixture();
    const sessionId = await f.bind();
    f.client.run.mockResolvedValueOnce(ok(actionReceipt(identity)));
    const result = await f.call("act", { ...act(sessionId), verifyAfter: true });
    expect(content(result)).toMatchObject({ error: { code: "unknown_outcome" } });
    expect(result.content[0].text).not.toContain("other-");
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.cancel", {
      sessionId: "native-session",
    });
    const calls = f.client.run.mock.calls.length;
    expect((await f.call("act", act(sessionId))).isError).toBe(true);
    expect(f.client.run.mock.calls).toHaveLength(calls);
    expect(f.client.run.mock.calls.map((call) => call[1])).not.toContain("computer.verify");
  });

  it("preserves a known dispatch when verification does not match its action", async () => {
    const f = fixture();
    const sessionId = await f.bind();
    const incorrect = actionReceipt({
      actionId: "other-action",
      status: "verified",
      effectVerified: true,
    });
    f.client.run.mockImplementationOnce(echoAction()).mockResolvedValueOnce(ok(incorrect));
    const result = await f.call("act", { ...act(sessionId), verifyAfter: true });
    expect(result.isError).toBe(true);
    expect(content(result)).toMatchObject({
      act: {
        sessionId,
        actionId: "action",
        status: "dispatched_unverified",
        effectVerified: false,
      },
      verify: { error: { code: "invalid_action_receipt" } },
    });
    expect(result.content[0].text).not.toContain("other-action");
    f.client.run.mockResolvedValueOnce(ok(incorrect));
    expect(content(await f.call("verify", { sessionId, actionId: "action" }))).toMatchObject({
      error: { code: "invalid_action_receipt" },
    });
  });

  it("does not expose or adopt a cancellation receipt from a different session", async () => {
    const f = fixture();
    const sessionId = await f.bind();
    f.client.run.mockResolvedValueOnce(
      ok({ sessionId: "other-session", stopConfirmed: true, terminalCause: "cancelled" }),
    );
    const result = await f.call("cancel", { sessionId });
    expect(content(result)).toMatchObject({ error: { code: "stop_unconfirmed" } });
    expect(result.content[0].text).not.toContain("other-session");
    expect((await f.call("act", act(sessionId))).isError).toBe(true);
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.cancel", {
      sessionId: "native-session",
    });
  });

  it("refuses foreign observations and a screenshot sent through JSON", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    for (const fields of [
      { sessionId: "other-session" },
      { scope: "desktop" },
      { screenshot: { data: "private-image" } },
    ]) {
      f.client.run.mockResolvedValueOnce(
        ok(observed({ ...fields, elements: [{ ref: "private-field" }] })),
      );
      const refused = await f.call("observe", { sessionId });
      expect(content(refused)).toMatchObject({ error: { code: "invalid_observation" } });
      expect(refused.content[0].text).not.toMatch(/other-session|private-(image|field)/);
    }
    const valid = await f.call("observe", { sessionId });
    expect(content(valid)).toMatchObject({ result: { sessionId, stateVersion: 1 } });
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.observe", {
      sessionId: "native-session",
      full: true,
    });
  });

  it("recovers window discovery after takeover without replaying old input", async () => {
    const f = fixture(true);
    const stoppedSession = await f.bind();
    f.client.run.mockResolvedValueOnce(
      remoteError("target_takeover", { terminalCause: "takeover" }),
    );
    const stopped = await f.call("observe", { sessionId: stoppedSession });
    expect(content(stopped).error.message).toMatch(
      /back in the background.*same authorized device/,
    );
    expect(content(stopped).error.message).toContain(
      "could not determine who or what changed focus",
    );
    const calls = f.client.run.mock.calls.length;
    const refused = await f.call("act", act(stoppedSession));
    expect(content(refused).error).toMatchObject({
      code: "session_stopped",
      details: { terminalCause: "takeover" },
    });
    expect(f.client.run.mock.calls).toHaveLength(calls);
    const { windows } = content(await f.call("windows", { deviceId: "device" })).result;
    f.client.run.mockResolvedValueOnce(
      ok({
        sessionId: "new-native-session",
        scope: "background",
        capabilities: {
          actions: ["setValue"],
          coordinateSpace: "window_image_pixels",
          realPointer: false,
        },
      }),
    );
    const rebound = content(
      await f.call("bind", { deviceId: "device", windowRef: windows[0].windowRef }),
    ).result.sessionId;
    expect(rebound).not.toBe(stoppedSession);
    f.client.run.mockResolvedValueOnce(ok(observed({ sessionId: "new-native-session" })));
    expect(content(await f.call("observe", { sessionId: rebound }))).toMatchObject({
      result: { sessionId: rebound, stateVersion: 1 },
    });
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.observe", {
      sessionId: "new-native-session",
      full: true,
    });
  });

  it("guides window rediscovery when a bound window is invalidated or capture stops", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    f.client.run.mockResolvedValueOnce(
      remoteError("window_missing_or_not_visible", { terminalCause: "invalidated" }),
    );
    expect(content(await f.call("observe", { sessionId })).error).toMatchObject({
      code: "window_missing_or_not_visible",
      message: expect.stringMatching(/could not prove.*covered.*list windows/i),
      details: { terminalCause: "invalidated" },
    });
  });

  it("keeps observation regions on the advertised binding and starts a fresh lineage when they change", async () => {
    const region = { x: 10, y: 15, width: 70, height: 60 };
    const legacy = fixture(true);
    const oldSession = await legacy.bind();
    legacy.client.run.mockClear();
    expect(content(await legacy.call("observe", { sessionId: oldSession, region }))).toMatchObject({
      error: { code: "unsupported_observation_region" },
    });
    expect(legacy.client.run).not.toHaveBeenCalled();

    const f = fixture(true, true);
    const sessionId = await f.bind();
    const snapshot = (
      area: typeof region & { fromEnd?: boolean },
      version: number,
      lineageId: string,
    ) =>
      ok(
        observed({
          region: area,
          stateVersion: version,
          viewport: { coordinateSpace: "window_image_pixels", width: 120, height: 120 },
          delta: {
            mode: "full",
            lineageId,
            baseVersion: null,
            version,
            complete: true,
            added: [],
            changed: [],
            removed: [],
          },
        }),
      );
    f.client.run.mockResolvedValueOnce(snapshot(region, 1, "head"));
    expect(
      content(await f.call("observe", { sessionId, region: { ...region, fromEnd: false } })),
    ).toMatchObject({ result: { region, stateVersion: 1 } });

    const tail = { ...region, fromEnd: true };
    f.client.run.mockResolvedValueOnce(snapshot(region, 2, "wrong-region"));
    expect(
      content(await f.call("observe", { sessionId, region: tail, baseVersion: 1 })),
    ).toMatchObject({ error: { code: "invalid_observation" } });
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.observe", {
      sessionId: "native-session",
      region: tail,
      full: true,
    });

    f.client.run.mockResolvedValueOnce(snapshot(tail, 2, "head"));
    expect(content(await f.call("observe", { sessionId, region: tail }))).toMatchObject({
      error: { code: "invalid_observation" },
    });
    f.client.run.mockResolvedValueOnce(snapshot(tail, 3, "tail"));
    expect(content(await f.call("observe", { sessionId, region: tail }))).toMatchObject({
      result: { region: tail, stateVersion: 3 },
    });
  });

  it("keeps one opaque lineage and rejects deltas outside the delivered baseline", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    const delta = {
      lineageId: "native-session",
      baseVersion: null,
      version: 1,
      complete: true,
      mode: "full",
      added: ["field"],
      changed: [],
      removed: [],
    };
    f.client.run.mockResolvedValueOnce(ok(observed({ delta, elements: [{ ref: "field" }] })));
    const first = content(await f.call("observe", { sessionId })).result;
    expect(first.delta.lineageId).not.toBe("native-session");
    const incremental = { ...delta, mode: "delta", added: [], baseVersion: 1, version: 2 };
    f.client.run.mockResolvedValueOnce(
      ok(observed({ stateVersion: 2, delta: { ...incremental, lineageId: "other-lineage" } })),
    );
    expect(content(await f.call("observe", { sessionId }))).toMatchObject({
      error: { code: "invalid_observation" },
    });
    f.client.run.mockResolvedValueOnce(ok(observed({ stateVersion: 2, delta: incremental })));
    const second = content(await f.call("observe", { sessionId })).result;
    expect(second.delta).toMatchObject({
      lineageId: first.delta.lineageId,
      baseVersion: 1,
      version: 2,
    });
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.observe", {
      sessionId: "native-session",
      baseVersion: 1,
    });
  });

  it("trims redundant model geometry and keeps actionable refs, uncertainty and values", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    const elements = [
      {
        ref: "field",
        parentRef: "group",
        role: "AXTextField",
        actions: ["setValue"],
        title: "",
        value: "",
        titleTruncated: false,
        valueTruncated: true,
        imageFrame: [1, 2, 3, 4],
        frame: [10, 20, 30, 40],
        windowFrame: [5, 6, 7, 8],
      },
      { ref: "group", frame: [0, 0, 100, 100], imageFrame: [], enabled: false },
    ];
    f.client.run.mockResolvedValueOnce(ok(observed({ elements })));
    expect(content(await f.call("observe", { sessionId })).result.elements).toEqual([
      {
        ref: "field",
        parentRef: "group",
        role: "AXTextField",
        actions: ["setValue"],
        value: "",
        valueTruncated: true,
        imageFrame: [1, 2, 3, 4],
      },
      elements[1],
    ]);
    expect(elements[0].frame).toEqual([10, 20, 30, 40]);
  });

  it("shares known flags only among the compact records in the current reply", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    const rows = [
      { ref: "root", enabled: true, focused: false },
      { ref: "field", enabled: true, focused: true },
      { ref: "button", enabled: false },
    ];
    const delta = {
      mode: "full",
      lineageId: "flags",
      baseVersion: null,
      version: 1,
      complete: true,
      added: rows.map((row) => row.ref),
      changed: [],
      removed: [],
    };
    f.client.run.mockResolvedValueOnce(ok(observed({ elements: rows, delta })));
    const first = content(await f.call("observe", { sessionId })).result;
    expect(first.elementDefaults).toEqual({ enabled: true });
    expect(first.elements[0]).not.toHaveProperty("enabled");
    expect(first.elements.map((row: object) => ({ ...first.elementDefaults, ...row }))).toEqual(
      rows,
    );
    const changed = { ...rows[1], enabled: false };
    f.client.run.mockResolvedValueOnce(
      ok(
        observed({
          stateVersion: 2,
          elements: [changed],
          delta: {
            ...delta,
            mode: "delta",
            baseVersion: 1,
            version: 2,
            added: [],
            changed: ["field"],
          },
        }),
      ),
    );
    const next = content(await f.call("observe", { sessionId })).result;
    expect(next.elementDefaults).toBeUndefined();
    expect(next.elements).toEqual([changed]);
  });

  it("shares ordered action lists without adding capabilities to other elements", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    const common = { actions: ["move", "click"], axActions: ["AXPress"] };
    const rows = [
      { ref: "first", ...common },
      { ref: "second", ...common },
      { ref: "third", ...common },
      { ref: "reordered", actions: ["click", "move"], axActions: [] },
      { ref: "disabled", actions: [], axActions: [] },
    ];
    f.client.run.mockResolvedValueOnce(ok(observed({ elements: rows })));
    const compact = content(await f.call("observe", { sessionId })).result;
    expect(compact.elementDefaults).toEqual(common);
    expect(compact.elements[0]).toEqual({ ref: "first" });
    expect(compact.elements.map((row: object) => ({ ...compact.elementDefaults, ...row }))).toEqual(
      rows,
    );

    const unknown = [...rows, { ref: "legacy" }];
    f.client.run.mockResolvedValueOnce(ok(observed({ elements: unknown, stateVersion: 2 })));
    const legacy = content(await f.call("observe", { sessionId })).result;
    expect(legacy.elementDefaults).toBeUndefined();
    expect(legacy.elements).toEqual(unknown);
  });

  it("compacts layout groups while keeping target refs and reparenting projected deltas", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    const elements = [
      { ref: "root", parentRef: null, index: 0, role: "AXWindow" },
      { ref: "group", parentRef: "root", index: 3, role: "AXGroup", actions: [] },
      { ref: "inner", parentRef: "group", index: 0, role: "AXGroup", actions: [] },
      {
        ref: "button",
        parentRef: "inner",
        index: 1,
        role: "AXButton",
        title: "Open topic",
        actions: ["press"],
      },
      {
        ref: "named-group",
        parentRef: "root",
        index: 4,
        role: "AXGroup",
        title: "Topic group",
        actions: [],
      },
      { ref: "label", parentRef: "named-group", index: 0, role: "AXStaticText", value: "Topic" },
      {
        ref: "wide-target",
        parentRef: "root",
        index: 5,
        role: "AXGroup",
        actions: ["click"],
        imageFrame: [10, 10, 80, 20],
      },
      {
        ref: "narrow-target",
        parentRef: "wide-target",
        index: 0,
        role: "AXButton",
        title: "Target",
        actions: ["click"],
        imageFrame: [10, 10, 40, 20],
      },
    ];
    const baseline = {
      mode: "full",
      lineageId: "native",
      baseVersion: null,
      version: 1,
      complete: true,
      added: elements.map((element) => element.ref),
      changed: [],
      removed: [],
    };
    f.client.run.mockResolvedValueOnce(ok(observed({ elements, delta: baseline })));
    const first = content(await f.call("observe", { sessionId })).result;
    expect(first.view).toBe("compact");
    expect(first.elements.map((element: { ref: string }) => element.ref)).toEqual([
      "root",
      "button",
      "named-group",
      "label",
      "wide-target",
      "narrow-target",
    ]);
    expect(first.elements[1]).toMatchObject({ ref: "button", parentRef: "root", index: 3 });
    expect(first.delta.added).not.toContain("inner");
    await f.call("act", { ...act(sessionId), ref: "button", action: { type: "press" } });
    expect(f.client.run).toHaveBeenLastCalledWith(
      "device",
      "computer.act",
      expect.objectContaining({ ref: "button", stateVersion: 1 }),
    );

    const incoming = {
      ...baseline,
      mode: "delta",
      baseVersion: 1,
      version: 2,
      added: ["second"],
    };
    f.client.run.mockResolvedValueOnce(
      ok(
        observed({
          stateVersion: 2,
          elements: [
            { ref: "second", parentRef: "group", index: 2, role: "AXStaticText", value: "Second" },
          ],
          delta: incoming,
        }),
      ),
    );
    const second = content(await f.call("observe", { sessionId, view: "compact" })).result;
    expect(second.delta).toMatchObject({
      mode: "delta",
      lineageId: first.delta.lineageId,
      added: ["group", "second"],
      changed: ["button"],
      removed: [],
    });
    expect(second.elements[1]).toMatchObject({ ref: "button", parentRef: "group", index: 0 });

    f.client.run.mockResolvedValueOnce(
      ok(
        observed({
          stateVersion: 3,
          delta: { ...incoming, baseVersion: 2, version: 3, added: [] },
        }),
      ),
    );
    const detailed = content(await f.call("observe", { sessionId, view: "detailed" })).result;
    expect(detailed).toMatchObject({
      view: "detailed",
      delta: { mode: "full", baseVersion: null },
    });
    expect(detailed.delta.lineageId).not.toBe(first.delta.lineageId);
    expect(detailed.elements).toContainEqual(expect.objectContaining({ ref: "inner" }));
    expect(detailed.elements).toContainEqual(
      expect.objectContaining({ ref: "button", parentRef: "inner", index: 1 }),
    );
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.observe", {
      sessionId: "native-session",
      baseVersion: 2,
    });
  });

  it("keeps partial groups unless the device proves they have exactly one child", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    const layout = { role: "AXGroup", parentRef: "root", actions: [] };
    const elements = [
      { ref: "root", parentRef: null, index: 0, role: "AXWindow" },
      { ...layout, ref: "unknown", index: 0 },
      { ...layout, ref: "one-child", index: 1, childCount: 1, selectedTextRange: [0, 0] },
      { ...layout, ref: "other-children", index: 2, childCount: 2 },
      {
        ...layout,
        ref: "editable",
        index: 3,
        childCount: 1,
        selectedTextRange: [0, 0],
        selectionSettable: true,
      },
      { ref: "text-a", parentRef: "unknown", index: 0, role: "AXStaticText", value: "A" },
      { ref: "text-b", parentRef: "one-child", index: 0, role: "AXStaticText", value: "B" },
      { ref: "text-c", parentRef: "other-children", index: 0, role: "AXStaticText", value: "C" },
      { ref: "text-d", parentRef: "editable", index: 0, role: "AXStaticText", value: "D" },
    ];
    f.client.run.mockResolvedValueOnce(ok(observed({ elements, complete: false })));
    const result = content(await f.call("observe", { sessionId })).result;
    expect(result.complete).toBe(false);
    expect(result.elements.map((element: { ref: string }) => element.ref)).toEqual([
      "root",
      "unknown",
      "text-a",
      "text-b",
      "other-children",
      "text-c",
      "editable",
      "text-d",
    ]);
    expect(result.elements).toContainEqual(
      expect.objectContaining({ ref: "text-b", parentRef: "root", index: 1 }),
    );
  });

  it("expands a current branch with stable refs and diffs only the selected subtree", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    const elements = [
      { ref: "root", parentRef: null, index: 0, role: "AXWindow" },
      { ref: "branch", parentRef: "root", index: 2, role: "AXList", title: "Topics" },
      { ref: "wrapper", parentRef: "branch", index: 0, role: "AXGroup", actions: [] },
      { ref: "topic", parentRef: "wrapper", index: 0, role: "AXButton", title: "Open" },
      { ref: "aside", parentRef: "root", index: 3, role: "AXStaticText", value: "Aside" },
    ];
    const baseline = {
      mode: "full",
      lineageId: "native",
      baseVersion: null,
      version: 1,
      complete: true,
      added: elements.map((element) => element.ref),
      changed: [],
      removed: [],
    };
    const refresh = (version: number, changes: Array<Record<string, unknown> & { ref: string }>) =>
      f.client.run.mockResolvedValueOnce(
        ok(
          observed({
            stateVersion: version,
            elements: changes,
            delta: {
              ...baseline,
              mode: "delta",
              baseVersion: version - 1,
              version,
              added: [],
              changed: changes.map(({ ref }) => ref),
            },
          }),
        ),
      );
    f.client.run.mockResolvedValueOnce(ok(observed({ elements, delta: baseline })));
    const whole = content(await f.call("observe", { sessionId })).result;
    const expand = (subtreeRef: string) =>
      f.call("observe", { sessionId, view: "detailed", subtreeRef });

    refresh(2, []);
    const subtree = content(await expand("branch")).result;
    expect(subtree).toMatchObject({
      subtreeRef: "branch",
      stateVersion: 2,
      delta: { mode: "full", baseVersion: null, added: ["branch", "wrapper", "topic"] },
    });
    expect(subtree.elements).toEqual([
      { ...elements[1], parentRef: null },
      elements[2],
      elements[3],
    ]);
    expect(subtree.delta.lineageId).not.toBe(whole.delta.lineageId);
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.observe", {
      sessionId: "native-session",
      baseVersion: 1,
    });

    refresh(3, [
      { ...elements[3], title: "Opened" },
      { ...elements[4], value: "Outside change" },
    ]);
    const change = content(await expand("branch")).result;
    expect(change.elements).toEqual([{ ...elements[3], title: "Opened" }]);
    expect(change.delta).toMatchObject({
      lineageId: subtree.delta.lineageId,
      mode: "delta",
      baseVersion: 2,
      changed: ["topic"],
      added: [],
      removed: [],
    });

    refresh(4, []);
    const another = content(await expand("aside")).result;
    expect(another.delta.lineageId).not.toBe(subtree.delta.lineageId);
    expect(another.elements).toEqual([
      { ...elements[4], parentRef: null, value: "Outside change" },
    ]);
    expect(another.delta).toMatchObject({ mode: "full", baseVersion: null });

    refresh(5, []);
    const absent = await expand("missing");
    expect(content(absent)).toMatchObject({ error: { code: "observation_subtree_unavailable" } });
    expect(absent.content[0].text).not.toContain("Outside change");
  });

  it("delivers a full tree with 512 elements within the agent tool response limit", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    const elements = Array.from({ length: 512 }, (_, index) => ({
      ref: `row-${String(index).padStart(32, "0")}`,
      parentRef: index === 0 ? null : "row-00000000000000000000000000000000",
      index,
      role: "AXGroup",
      identifier: "",
      identifierSource: "missing",
      title: `Group ${index}`,
      value: "Description ".repeat(7),
      valueType: "string",
      valueTruncated: false,
      enabled: true,
      focusedAvailable: false,
      selectedTextRangeAvailable: false,
      enabledAvailable: true,
      secure: false,
      valueSettable: false,
      frameAvailable: true,
      windowFrameAvailable: true,
      readOnly: false,
      frame: [10, 20, 30, 40],
      windowFrame: [10, 20, 30, 40],
      imageFrame: [10, 20, 30, 40],
      axActions: [],
      actions: ["press"],
    }));
    f.client.run.mockResolvedValueOnce(
      ok(
        observed({
          elements,
          delta: {
            lineageId: "large-tree",
            baseVersion: null,
            version: 1,
            complete: true,
            mode: "full",
            added: elements.map(({ ref }) => ref),
            changed: [],
            removed: [],
          },
        }),
      ),
    );
    const result = content(await f.call("observe", { sessionId })).result;
    expect(result.elements).toHaveLength(512);
    expect({ ...result.elementDefaults, ...result.elements[511] }).toMatchObject({
      ref: elements[511].ref,
      parentRef: elements[511].parentRef,
      title: "Group 511",
      actions: ["press"],
      imageFrame: [10, 20, 30, 40],
    });
  });

  it("drops an older observation reply after a newer request has completed", async () => {
    const f = fixture(true);
    const sessionId = await f.bind();
    let release: (response: ActionResponse) => void = () => {};
    let sent: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const pending = new Promise<ActionResponse>((resolve) => {
      release = resolve;
    });
    f.client.run.mockImplementationOnce(() => {
      sent();
      return pending;
    });
    const first = f.call("observe", { sessionId });
    await started;
    f.client.run.mockResolvedValueOnce(ok(observed({ stateVersion: 2 })));
    expect(content(await f.call("observe", { sessionId }))).toMatchObject({
      result: { stateVersion: 2 },
    });
    release(ok(observed({ elements: [{ ref: "older-field" }] })));
    const result = await first;
    expect(content(result)).toMatchObject({ error: { code: "superseded_observation" } });
    expect(result.content[0].text).not.toContain("older-field");
  });

  it("keeps screenshot bytes on the binary path and validates their bounded identity", async () => {
    const f = fixture();
    const sessionId = await f.bind();
    const body = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aONsAAAAASUVORK5CYII=",
      "base64",
    );
    const image = {
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteLength: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    f.client.runBinary.mockResolvedValue({
      response: ok(observed({ screenshot: image })),
      body,
    });
    const result = await f.call("observe", { sessionId, screenshot: true });
    expect(result.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: body.toString("base64"),
    });
    expect(f.client.runBinary).toHaveBeenCalledTimes(1);
    f.client.runBinary.mockResolvedValueOnce({
      response: ok(observed({ sessionId: "other-session", screenshot: image })),
      body,
    });
    const foreign = await f.call("observe", { sessionId, screenshot: true });
    expect(content(foreign)).toMatchObject({ error: { code: "invalid_observation" } });
    expect(foreign.content).toHaveLength(1);
    f.client.runBinary.mockResolvedValueOnce({
      response: ok(observed({ screenshot: { ...image, sha256: "0".repeat(64) } })),
      body,
    });
    expect((await f.call("observe", { sessionId, screenshot: true })).isError).toBe(true);
    f.client.runBinary.mockResolvedValueOnce({
      response: ok(
        observed({
          observationId: "mismatch",
          stateVersion: 2,
          screenshot: { ...image, width: 2 },
        }),
      ),
      body,
    });
    expect((await f.call("observe", { sessionId, screenshot: true })).isError).toBe(true);
  });

  it("cancels an agent's bindings on close and rejects new calls", async () => {
    const f = fixture();
    await f.bind();
    await f.service.close();
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.cancel", {
      sessionId: "native-session",
    });
    expect(f.client.disconnect).toHaveBeenCalledOnce();
    expect((await f.call("status", {})).isError).toBe(true);
  });

  it("closes only bindings of the finished turn that lack a confirmed stop", async () => {
    const f = turnCleanupFixture();
    const finished = f.caller("finished");
    const next = f.caller("next");
    const otherAgent = f.caller("finished", "another-agent-session");
    const open = await f.bind(finished);
    const ended = await f.bind(finished);
    expect((await f.service.run(finished, "end", { sessionId: ended })).isError).toBeUndefined();
    const cancelled = await f.bind(finished);
    expect(
      (await f.service.run(finished, "cancel", { sessionId: cancelled })).isError,
    ).toBeUndefined();
    const pendingStop = await f.bind(finished);
    f.run.mockResolvedValueOnce(
      ok({
        sessionId: "binding-4",
        terminalCause: "completed",
        stopConfirmed: false,
        effectVerified: false,
      }),
    );
    expect(
      (await f.service.run(finished, "end", { sessionId: pendingStop })).isError,
    ).toBeUndefined();
    const nextSession = await f.bind(next);
    const otherSession = await f.bind(otherAgent);
    const expiredRef = await f.list(finished);
    f.run.mockClear();

    await f.service.cancelTurn?.(finished.sessionId, "finished");
    expect(f.run.mock.calls).toEqual([
      ["computer.cancel", { sessionId: "binding-1" }, `local-core:${f.deviceId}`, undefined],
      ["computer.cancel", { sessionId: "binding-4" }, `local-core:${f.deviceId}`, undefined],
    ]);
    expect((await f.service.run(finished, "observe", { sessionId: open })).isError).toBe(true);
    expect(
      (await f.service.run(finished, "bind", { deviceId: f.deviceId, windowRef: expiredRef }))
        .isError,
    ).toBe(true);
    expect(
      (await f.service.run(next, "observe", { sessionId: nextSession })).isError,
    ).toBeUndefined();
    expect(
      (await f.service.run(otherAgent, "observe", { sessionId: otherSession })).isError,
    ).toBeUndefined();
  });

  it("cancels a bind arriving after its turn closes and never exposes an alias", async () => {
    const f = turnCleanupFixture();
    const caller = f.caller("finished");
    const windowRef = await f.list(caller);
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    let complete!: (response: ActionResponse) => void;
    const reply = new Promise<ActionResponse>((resolve) => {
      complete = resolve;
    });
    f.run.mockImplementationOnce(async () => {
      markSent();
      return reply;
    });
    const binding = f.service.run(caller, "bind", { deviceId: f.deviceId, windowRef });
    await sent;
    const cleanup = f.service.cancelTurn?.(caller.sessionId, "finished");
    complete(ok({ sessionId: "late-native-session", scope: "background" }));
    expect(content(await binding)).toMatchObject({ error: { code: "computer_use_denied" } });
    await cleanup;
    expect(f.run.mock.calls.map(([action, args]) => [action, args])).toEqual([
      ["computer.windows", {}],
      ["computer.bind", { windowRef: "window" }],
      ["computer.cancel", { sessionId: "late-native-session" }],
    ]);
  });

  it("keeps the transport until a pending bind and its cancellation settle", async () => {
    const f = fixture();
    const listed = await f.call("windows", { deviceId: "device" });
    const windowRef = JSON.parse(listed.content[0].text).result.windows[0].windowRef;
    f.client.run.mockClear();
    let started = () => {};
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finishBinding = (_value: ActionResponse) => {};
    const reply = new Promise<ActionResponse>((resolve) => {
      finishBinding = resolve;
    });
    let cancelling = () => {};
    const cancelled = new Promise<void>((resolve) => {
      cancelling = resolve;
    });
    let finishCancellation = () => {};
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    f.client.run.mockImplementation(async (_device, action) => {
      if (action === "computer.bind") {
        started();
        return reply;
      }
      if (action === "computer.cancel") {
        cancelling();
        await cancellation;
      }
      return ok({});
    });
    const binding = f.call("bind", { deviceId: "device", windowRef });
    await sent;
    const closing = f.service.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.client.disconnect).not.toHaveBeenCalled();
    finishBinding(ok({ sessionId: "late-native-session" }));
    await cancelled;
    expect(f.client.disconnect).not.toHaveBeenCalled();
    finishCancellation();
    expect((await binding).isError).toBe(true);
    await closing;
    expect(f.client.run).toHaveBeenLastCalledWith("device", "computer.cancel", {
      sessionId: "late-native-session",
    });
    expect(f.client.disconnect).toHaveBeenCalledOnce();
  });

  it("settles a rejected bind during concurrent close calls", async () => {
    const f = fixture();
    const listed = await f.call("windows", { deviceId: "device" });
    const windowRef = JSON.parse(listed.content[0].text).result.windows[0].windowRef;
    f.client.run.mockClear();
    let started = () => {};
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    let failBinding = (_error: Error) => {};
    const reply = new Promise<ActionResponse>((_resolve, reject) => {
      failBinding = reject;
    });
    f.client.run.mockImplementation(async () => {
      started();
      return reply;
    });
    const binding = f.call("bind", { deviceId: "device", windowRef });
    await sent;
    const closing = [f.service.close(), f.service.close()];
    const rejected = expect(binding).rejects.toThrow("Binding unavailable");
    failBinding(new Error("Binding unavailable"));
    await rejected;
    await Promise.all(closing);
    expect(f.client.disconnect).toHaveBeenCalledOnce();
    expect(f.client.run.mock.calls.every((call) => call[1] === "computer.bind")).toBe(true);
  });

  it("bounds parallel binding requests before their device responses arrive", async () => {
    const f = fixture();
    f.client.run.mockResolvedValueOnce(
      ok({
        windows: Array.from({ length: 129 }, (_, index) => ({
          windowRef: `native-window-${index}`,
        })),
      }),
    );
    const listed = await f.call("windows", { deviceId: "device" });
    const refs = JSON.parse(listed.content[0].text).result.windows.map(
      (window: { windowRef: string }) => window.windowRef,
    ) as string[];
    f.client.run.mockClear();
    let finish: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let sequence = 0;
    f.client.run.mockImplementation(async () => {
      await wait;
      return ok({ sessionId: `native-${sequence++}` });
    });
    const pending = Array.from({ length: 128 }, (_, index) =>
      f.call("bind", { deviceId: "device", windowRef: refs[index] }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const overflow = await f.call("bind", { deviceId: "device", windowRef: refs[128] });
    expect(overflow.isError).toBe(true);
    expect(f.client.run).toHaveBeenCalledTimes(128);
    finish();
    await Promise.all(pending);
  });

  it("reclaims bindings whose remote stops are confirmed", async () => {
    const f = fixture();
    for (let index = 0; index < 129; index++) {
      const sessionId = await f.bind();
      f.client.run.mockResolvedValueOnce(
        ok({ sessionId: "native-session", terminalCause: "cancelled", stopConfirmed: true }),
      );
      expect((await f.call("cancel", { sessionId })).isError).toBeUndefined();
      const calls = f.client.run.mock.calls.length;
      expect((await f.call("act", act(sessionId))).isError).toBe(true);
      expect(f.client.run.mock.calls).toHaveLength(calls);
    }
  });
});
