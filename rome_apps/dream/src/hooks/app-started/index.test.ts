import { describe, expect, it, rs } from "@rstest/core";
import type { AppStartedEvent, AppStartedHookDeps } from "@rome-os/app-runtime";
import { createHook } from "./index.js";

const event: AppStartedEvent = {
  type: "app-started",
  version: 1,
  appId: "dream",
  appVersion: "0.1.5",
};

function deps(routineNames: string[]) {
  const runAction = rs.fn().mockResolvedValue({ status: "ok" });
  const info = rs.fn();
  const hookDeps = {
    appId: "dream",
    logger: { info, warn: rs.fn(), error: rs.fn(), debug: rs.fn() },
    appContext: {
      listRoutines: rs
        .fn()
        .mockResolvedValue(routineNames.map((name) => ({ name, actionName: "dream" }))),
      runAction,
    },
  } as unknown as AppStartedHookDeps;
  return { hookDeps, runAction, info };
}

describe("dream app-started hook", () => {
  it("registers the daily routine on first start", async () => {
    const { hookDeps, runAction, info } = deps([]);

    await createHook(hookDeps).onAppStarted(event);

    expect(runAction).toHaveBeenCalledWith(
      "create_routine",
      expect.objectContaining({ name: "daily-dream", actionName: "dream" }),
    );
    expect(info).toHaveBeenCalledWith("registered the daily dream routine");
  });

  it("does nothing on a later start", async () => {
    const { hookDeps, runAction, info } = deps(["daily-dream"]);

    await createHook(hookDeps).onAppStarted(event);

    expect(runAction).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
