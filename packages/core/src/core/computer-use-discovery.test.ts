import type { ActionResponse } from "@rome-os/node-core";
import { describe, expect, it, rs } from "@rstest/core";
import { discoverComputerUseDevice } from "./computer-use-discovery.js";

const ok = (result: unknown): ActionResponse => ({ type: "response", ok: true, result });
const failed = (code: string): ActionResponse => ({
  type: "response",
  ok: false,
  error: { code, message: "Private transport diagnostics" },
});

function device(info: ActionResponse, status = ok({})) {
  const run = rs.fn(async (_deviceId: string, action: string, _args?: unknown) =>
    action === "system.info" ? info : status,
  );
  return { run, discover: () => discoverComputerUseDevice("exact-device", { run }) };
}

describe("computer-use capability discovery", () => {
  it("reads only one exact device and uses advertisements even when versions differ", async () => {
    const subject = device(
      ok({
        platform: "macos",
        version: "9.2.0",
        frameVersion: 8,
        transferVersion: 6,
        actions: ["system.info", "computer.status", "computer.bind", "computer.end"],
        capabilities: [{ prefix: "computer", configured: true, version: 7 }],
        audit: { state: "ok", message: "Private audit diagnostics" },
      }),
      ok({
        version: "74",
        protocolVersion: 4,
        permissions: { accessibility: true, screenCapture: false, privatePath: "/private/token" },
        focus: { sessions: [{ title: "Private window title" }] },
        capabilities: {
          background: {
            actions: ["setValue"],
            realPointer: false,
            sessionEnd: true,
            windowPreemption: true,
            sessionRecovery: true,
            durableWindowOccupancy: true,
            observationRegion: true,
            screenshots: false,
            extra: "Private helper metadata",
          },
        },
      }),
    );
    const result = await subject.discover();
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      deviceId: "exact-device",
      availability: "online",
      platform: "macos",
      version: "9.2.0",
      frameVersion: 8,
      transferVersion: 6,
      actions: ["system.info", "computer.status", "computer.bind", "computer.end"],
      audit: "ok",
      computer: {
        version: 7,
        helperVersion: "74",
        protocolVersion: 4,
        configured: true,
        actions: ["computer.status", "computer.bind", "computer.end"],
        permissions: { accessibility: true, screenCapture: false },
        background: {
          actions: ["setValue"],
          realPointer: false,
          sessionEnd: true,
          windowPreemption: true,
          sessionRecovery: true,
          durableWindowOccupancy: true,
          observationRegion: true,
          screenshots: false,
        },
      },
    });
    expect(subject.run.mock.calls).toEqual([
      ["exact-device", "system.info", {}],
      ["exact-device", "computer.status", {}],
    ]);
  });

  it("keeps a legacy peer discoverable without inventing missing capabilities", async () => {
    const subject = device(ok({ platform: "linux", version: 2 }));
    const result = await subject.discover();
    expect(result).toMatchObject({
      availability: "online",
      platform: "linux",
      version: 2,
    });
    expect(result.computer).toBeUndefined();
    expect(subject.run.mock.calls.every(([, action]) => action === "system.info")).toBe(true);
  });

  it("does not infer windowLease from computer.renew when missing or non-boolean", async () => {
    for (const windowLease of [undefined, "true"]) {
      const subject = device(
        ok({ actions: ["computer.status", "computer.renew"] }),
        ok({ capabilities: { background: { windowLease } } }),
      );
      const result = await subject.discover();
      expect(result.computer?.background?.windowLease).toBeUndefined();
    }
  });

  it.each([
    { actions: ["computer.status"], computerUse: false },
    { actions: ["computer.status"], capabilities: [{ prefix: "computer", configured: false }] },
    { actions: ["computer.status"], audit: { state: "unavailable" } },
    { actions: ["health.stats"] },
  ])("needs a compatible, enabled advertisement before reading helper status: %o", async (info) => {
    const subject = device(ok(info));
    expect(await subject.discover()).toMatchObject({ availability: "online" });
    expect(subject.run.mock.calls).toEqual([["exact-device", "system.info", {}]]);
  });

  it("accepts a capability-group advertisement when an older peer has no device-wide list", async () => {
    const subject = device(
      ok({
        capabilities: [{ prefix: "computer", actions: ["computer.status", "computer.status"] }],
      }),
      failed("unsupported_action"),
    );
    expect(await subject.discover()).toMatchObject({
      availability: "online",
      computer: { actions: ["computer.status"], statusError: "unsupported_action" },
    });
    expect(subject.run.mock.calls).toHaveLength(2);
  });

  it.each([
    ["target_unavailable", "offline"],
    ["unknown_outcome", "unknown"],
  ])("separates offline evidence from a transport failure: %s", async (code, availability) => {
    const subject = device(failed(code));
    expect(await subject.discover()).toEqual({
      deviceId: "exact-device",
      availability,
      discoveryError: code,
    });
    expect(subject.run.mock.calls).toHaveLength(1);
  });
});
