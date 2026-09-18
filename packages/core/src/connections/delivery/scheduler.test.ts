import { describe, expect, it } from "@rstest/core";
import { DeliveryScheduler } from "./scheduler.js";
import { resolveDeliveryProfile } from "./profile.js";
import { physicalDeliveryScope, physicalOperation } from "./physical-operation.js";
import { DeliveryFailure } from "./transport.js";

const profile = resolveDeliveryProfile(
  {
    mode: "edit",
    unsupportedMode: "blocks",
    budgetKey: "account",
    operationSpacingMs: 10,
    createSpacingMs: 10,
    updateSpacingMs: 10,
    conversationSpacingMs: 10,
    burstCapacity: 1,
    maxPartSize: 12,
    coalesceMs: 0,
    maxPendingAgeMs: 100,
    maxPendingBytes: 1000,
    maxQueuedOperations: 100,
    formatting: "plain",
    formattingFallback: true,
  },
  {},
  true,
);

describe("DeliveryScheduler", () => {
  it("rejects a full queue, releases cancelled capacity, and keeps other accounts independent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new DeliveryScheduler();
    const bounded = {
      ...profile,
      maxQueuedOperations: 1,
      operationSpacingMs: 0,
      createSpacingMs: 0,
      conversationSpacingMs: 0,
    };
    const sent: string[] = [];
    const active = scheduler.run(
      bounded,
      "a",
      "create",
      () => {},
      async () => {
        sent.push("active");
        await gate;
      },
    );
    const abort = new AbortController();
    const queued = scheduler.run(
      bounded,
      "b",
      "create",
      () => {},
      async () => {
        sent.push("cancelled");
      },
      abort.signal,
    );
    try {
      await expect(
        scheduler.run(
          bounded,
          "c",
          "create",
          () => {},
          async () => {
            sent.push("overflow");
          },
        ),
      ).rejects.toThrow("queue is full");
      await scheduler.run(
        { ...bounded, budgetKey: "another-account" },
        "a",
        "create",
        () => {},
        async () => {
          sent.push("independent");
        },
      );
      const cancelled = expect(queued).rejects.toThrow("stopped");
      abort.abort();
      await cancelled;
      const replacement = scheduler.run(
        bounded,
        "c",
        "create",
        () => {},
        async () => {
          sent.push("replacement");
        },
      );
      release();
      await Promise.all([active, replacement]);
      expect(sent).toEqual(["active", "independent", "replacement"]);
    } finally {
      release();
      await active;
    }
  });

  it("replenishes a depleted burst budget after idle time", async () => {
    let now = 0;
    const scheduler = new DeliveryScheduler(
      () => now,
      async (delay) => {
        now += delay;
      },
    );
    const burst = { ...profile, burstCapacity: 2, createSpacingMs: 0, conversationSpacingMs: 0 };
    const times: number[] = [];
    for (let index = 0; index < 6; index++) {
      if (index === 3) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        now = 100;
      }
      await scheduler.run(
        burst,
        "dm",
        "create",
        () => {},
        async () => {
          times.push(now);
        },
      );
    }
    expect(times).toEqual([0, 0, 10, 100, 100, 110]);
  });

  it("validates connection overrides and exposes the effective unsupported-mode fallback", () => {
    expect(
      resolveDeliveryProfile(profile, { mode: "edit", unsupportedMode: "final" }, false).mode,
    ).toBe("final");
    expect(
      resolveDeliveryProfile(profile, { updateSpacingMs: 30 }, true, { updateSpacingMs: 20 })
        .updateSpacingMs,
    ).toBe(30);
    expect(() => resolveDeliveryProfile(profile, { maxPartSize: 100 }, true)).toThrow(
      "transport limit",
    );
    expect(() => resolveDeliveryProfile(profile, { burstCapacity: 0 }, true)).toThrow();
    expect(() => resolveDeliveryProfile(profile, { platform: "synthetic" }, true)).toThrow();
  });

  it("cancels queued output promptly but still awaits an in-flight outcome", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new DeliveryScheduler();
    const active = scheduler.run(
      profile,
      "dm",
      "create",
      () => {},
      async () => {
        await gate;
      },
    );
    const abort = new AbortController();
    let sent = false;
    const pending = scheduler.run(
      profile,
      "dm",
      "create",
      () => {},
      async () => {
        sent = true;
      },
      abort.signal,
    );
    abort.abort();
    await expect(pending).rejects.toThrow("stopped");
    expect(sent).toBe(false);
    release();
    await active;
  });
  it("paces physical splits and attachments and resolves only after completion", async () => {
    let now = 0;
    const scheduler = new DeliveryScheduler(
      () => now,
      async (delay) => {
        now += delay;
      },
    );
    const operations: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolved = false;
    const send = physicalDeliveryScope
      .run({ scheduler, profile, assertAuthorized() {} }, async () => {
        for (const kind of ["split", "split", "attachment"]) {
          await physicalOperation("conversation", "create", async () => {
            operations.push(now);
            if (kind === "attachment") await gate;
          });
        }
      })
      .then(() => {
        resolved = true;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(operations).toEqual([0, 10, 20]);
    expect(resolved).toBe(false);
    release();
    await send;
    expect(resolved).toBe(true);
  });

  it("rotates conversations sharing an account and rechecks authority after waiting", async () => {
    let now = 0;
    let authorized = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new DeliveryScheduler(
      () => now,
      async (delay) => {
        now += delay;
      },
    );
    const sent: string[] = [];
    const first = scheduler.run(
      profile,
      "a",
      "create",
      () => {},
      async () => {
        sent.push("a1");
        await gate;
      },
    );
    const second = scheduler.run(
      profile,
      "a",
      "create",
      () => {
        if (!authorized) throw new Error("revoked");
      },
      async () => {
        sent.push("a2");
      },
    );
    const failure = expect(second).rejects.toThrow("revoked");
    const third = scheduler.run(
      profile,
      "b",
      "create",
      () => {},
      async () => {
        sent.push("b1");
        authorized = false;
      },
    );
    release();
    await Promise.all([first, third, failure]);
    expect(sent).toEqual(["a1", "b1"]);
  });

  it("honors retry-after across conversations without blindly retrying a create", async () => {
    let now = 0;
    const scheduler = new DeliveryScheduler(
      () => now,
      async (delay) => {
        now += delay;
      },
    );
    await expect(
      scheduler.run(
        profile,
        "a",
        "create",
        () => {},
        async () => {
          throw new DeliveryFailure("rate-limit", "slow down", [], 200);
        },
      ),
    ).rejects.toMatchObject({ kind: "rate-limit" });
    let sentAt = 0;
    await scheduler.run(
      profile,
      "b",
      "update",
      () => {},
      async () => {
        sentAt = now;
      },
    );
    expect(sentAt).toBe(200);
  });
});
