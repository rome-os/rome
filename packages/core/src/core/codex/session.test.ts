import { describe, expect, it } from "@rstest/core";
import { SerialTurnCoordinator, TurnDispatcher } from "./session.js";

describe("SerialTurnCoordinator", () => {
  it("serializes independent producers in submission order", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const coordinator = new SerialTurnCoordinator();
    const first = coordinator.run(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
    });
    const second = coordinator.run(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after a rejected producer and drains for shutdown", async () => {
    const coordinator = new SerialTurnCoordinator();
    const failed = coordinator.run(async () => {
      throw new Error("boom");
    });
    const recovered = coordinator.run(async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    await expect(recovered).resolves.toBe("ok");
    await expect(coordinator.waitForIdle()).resolves.toBeUndefined();
  });
});

describe("TurnDispatcher", () => {
  it("drains queued items in FIFO batches", async () => {
    const batches: number[][] = [];
    const dispatcher = new TurnDispatcher<number>({
      runOne: async (items) => {
        batches.push(items);
      },
    });

    dispatcher.enqueue(1);
    dispatcher.enqueue([2, 3]);
    await dispatcher.waitForIdle();

    expect(batches).toEqual([[1], [2, 3]]);
  });

  it("waitForIdle waits for the in-flight run before resolving after close", async () => {
    let finishRun!: () => void;
    let ran = false;
    const dispatcher = new TurnDispatcher<number>({
      runOne: async () => {
        ran = true;
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
    });

    dispatcher.enqueue(1);
    dispatcher.close();

    let idle = false;
    const idlePromise = dispatcher.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();

    expect(ran).toBe(true);
    expect(idle).toBe(false);

    finishRun();
    await idlePromise;

    expect(idle).toBe(true);
  });

  it("rejects input after close", () => {
    const dispatcher = new TurnDispatcher<number>({
      runOne: async () => {},
    });

    dispatcher.close();

    expect(() => dispatcher.enqueue(1)).toThrow("TurnDispatcher is closed");
  });
});
