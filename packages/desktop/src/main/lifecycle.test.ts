import { describe, expect, it, rs } from "@rstest/core";

rs.mock("electron", () => ({ app: { on: rs.fn(), quit: rs.fn() } }));
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

  // The private VM's stop used to get 45 s. Only a socket closes now, and a
  // quit must not hang on a network that never answers.
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
