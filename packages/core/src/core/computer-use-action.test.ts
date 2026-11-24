import { describe, expect, it, rs } from "@rstest/core";
import { actionExecutionContext, type ActionExecutionStore } from "../apps/actions/context.js";
import type { Action } from "../apps/actions/types.js";
import { registerComputerUseAction } from "./computer-use-action.js";

function setup() {
  let action: Action | undefined;
  const devices = { listDevices: rs.fn(async () => [{ id: "test-device" }]) };
  const audience = rs.fn(async (): Promise<"private" | "admin" | "shared"> => "private");
  registerComputerUseAction(
    {
      register: (value) => {
        action = value;
      },
    },
    devices,
    audience,
  );
  const turn: ActionExecutionStore = {
    executionId: "execution",
    rootExecutionId: "execution",
    initiator: "agent:core:main",
    actor: { kind: "guardian", userId: "guardian", via: "cookie" },
    audience: "private",
  };
  return {
    devices,
    audience,
    run: (patch: Partial<ActionExecutionStore> = {}) =>
      actionExecutionContext.run({ ...turn, ...patch }, () => action!.execute({})),
  };
}

describe("core:computer_use action", () => {
  it("lists authorized computers for a private guardian turn", async () => {
    const f = setup();
    expect(await f.run()).toMatchObject({ status: "ok", data: [{ id: "test-device" }] });
    expect(f.devices.listDevices).toHaveBeenCalledTimes(1);
  });

  it("does not query Cloud for a visitor, anonymous or shared turn", async () => {
    const f = setup();
    for (const patch of [
      { actor: undefined },
      { actor: { kind: "anonymous" as const } },
      { audience: "shared" as const },
    ]) {
      expect(await f.run(patch)).toMatchObject({ status: "error" });
    }
    expect(f.devices.listDevices).not.toHaveBeenCalled();
  });

  it("discards the device list if the chat becomes shared during discovery", async () => {
    const f = setup();
    f.audience.mockResolvedValueOnce("private").mockResolvedValueOnce("shared");
    expect(await f.run()).toMatchObject({
      status: "error",
      error: "computer_use_private_guardian_only",
    });
  });

  it("lists authorized computers for a dashboard admin's turn in a chat only they read", async () => {
    const f = setup();
    f.audience.mockResolvedValue("admin");
    const admin = { kind: "visitor" as const, accountId: "ada", email: "ada@example.test" };
    expect(await f.run({ actor: admin, audience: "admin" })).toMatchObject({ status: "ok" });
  });

  it("refuses a dashboard admin outside a chat only they read, or once off the team", async () => {
    const f = setup();
    const admin = { kind: "visitor" as const, accountId: "ada", email: "ada@example.test" };
    f.audience.mockResolvedValue("private");
    expect(await f.run({ actor: admin, audience: "private" })).toMatchObject({ status: "error" });
    // Off the team, the chat reads as shared.
    f.audience.mockResolvedValue("shared");
    expect(await f.run({ actor: admin, audience: "admin" })).toMatchObject({ status: "error" });
    expect(f.devices.listDevices).not.toHaveBeenCalled();
  });
});
