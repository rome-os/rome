import { describe, it, expect, rs } from "@rstest/core";
import { instanceWorkerCalls, type InstanceWorkerCallsDeps } from "./for-apps.js";

function makeCalls(overrides: Partial<InstanceWorkerCallsDeps> = {}) {
  return instanceWorkerCalls({
    systemUpgrade: { checkAndOffer: rs.fn() },
    feedback: { send: rs.fn() },
    cloudProfile: { get: rs.fn() },
    ...overrides,
  } as unknown as InstanceWorkerCallsDeps);
}

describe("feedback.send", () => {
  const input = {
    category: "bug",
    summary: "Broken",
    details: "Repro",
    reporter: { kind: "agent", agentName: "main", callerAppId: "some-app" },
  };
  it("forwards validated fields and runtime provenance", async () => {
    const send = rs.fn(async () => ({ kind: "ok" }));
    const calls = makeCalls({ feedback: { send } as never });
    expect(await calls["feedback.send"](input)).toEqual({ kind: "ok" });
    expect(send).toHaveBeenCalledWith(input);
  });
  it.each([
    { ...input, token: "spoof" },
    { ...input, reporter: { kind: "guardian" } },
    { ...input, reporter: { kind: "agent", extra: true } },
    { ...input, details: "x".repeat(4000) },
    { ...input, summary: "two\nlines" },
    { ...input, category: "invalid" },
  ])("rejects invalid RPC parameters without sending: %j", async (params) => {
    const send = rs.fn();
    const calls = makeCalls({ feedback: { send } as never });
    await expect(calls["feedback.send"](params)).rejects.toThrow("feedback.send: invalid params");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("system.upgrade.checkAndOffer and cloudProfile.get", () => {
  it("return what the instance services return", async () => {
    const calls = makeCalls({
      systemUpgrade: { checkAndOffer: rs.fn(async () => ({ kind: "up_to_date" })) } as never,
      cloudProfile: { get: rs.fn(async () => ({ kind: "ok", profile: {} })) } as never,
    });
    expect(await calls["system.upgrade.checkAndOffer"](undefined)).toEqual({ kind: "up_to_date" });
    expect(await calls["cloudProfile.get"](undefined)).toEqual({ kind: "ok", profile: {} });
  });
});
