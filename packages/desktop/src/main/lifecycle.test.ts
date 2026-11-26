import { describe, expect, it, rs } from "@rstest/core";

type QuitListener = (event: { preventDefault(): void }) => Promise<void>;
const app = rs.hoisted(() => ({
  on: rs.fn<(event: string, listener: QuitListener) => void>(),
  quit: rs.fn(),
}));
rs.mock("electron", () => ({ app }));
rs.mock("./logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import { runShutdown } from "./lifecycle";

describe("runShutdown", () => {
  it("waits for the device to disconnect", async () => {
    let done = false;
    await runShutdown(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    }, 1_000);
    expect(done).toBe(true);
  });

  it("gives up on a disconnect that never finishes", async () => {
    const started = Date.now();
    await runShutdown(() => new Promise<void>(() => {}), 20);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("quits even when the disconnect throws", async () => {
    await expect(
      runShutdown(async () => {
        throw new Error("socket gone");
      }, 1_000),
    ).resolves.toBeUndefined();
  });
});

it.each([
  "quit",
  "update",
])("drains the host before %s and shares the shutdown work", async (mode) => {
  rs.resetModules();
  const { prepareForUpdateInstall, setupLifecycle } = await import("./lifecycle");
  let finish = () => {};
  const stop = rs.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  setupLifecycle({ onShutdown: stop });
  const beforeQuit = app.on.mock.calls.at(-1)![1];
  const preventDefault = rs.fn();
  app.quit.mockClear();

  const exiting = mode === "quit" ? beforeQuit({ preventDefault }) : prepareForUpdateInstall();
  await beforeQuit({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(app.quit).not.toHaveBeenCalled();
  finish();
  await exiting;
  expect(app.quit).toHaveBeenCalledTimes(mode === "quit" ? 1 : 0);
  preventDefault.mockClear();
  await beforeQuit({ preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
});
