import { describe, expect, it, rs } from "@rstest/core";
import {
  claimTaskInputActor,
  taskInputActor,
  withTaskInputActor,
  type TaskInputSource,
} from "./task-input-actor.js";
import type { WebChatRepository } from "./repository.js";
import type { SessionActor } from "../access/session-actor.js";

const guardian: SessionActor = { kind: "guardian", userId: "synthetic-seat", via: "cookie" };
const visitor: SessionActor = { kind: "visitor", accountId: "v", email: "v@example.invalid" };
const body = { text: "inspect the public contract", skillName: "tikhub:tikhub" };
const speaker = { platform: "webchat", id: "core:concierge" };
const source = (overrides: Partial<TaskInputSource> = {}): TaskInputSource => ({
  agentName: "core:concierge",
  chatId: "source",
  turnId: "turn",
  actor: guardian,
  audience: "private",
  isCurrent: () => true,
  ...overrides,
});
function repository(owner = "guardian") {
  const rows = new Map([
    ["source", { id: "source", agentName: "core:concierge", ownerKey: owner, archivedAt: null }],
    ["target", { id: "target", triggerKind: "concierge", ownerKey: owner, archivedAt: null }],
  ]);
  return {
    rows,
    repo: { getSession: async (id: string) => rows.get(id) ?? null } as unknown as Pick<
      WebChatRepository,
      "getSession"
    >,
  };
}
const origin = async () => "source";

async function admitted(actor: SessionActor, owner: string) {
  const { repo } = repository(owner);
  return withTaskInputActor(source({ actor }), "target", body, async () => {
    const claim = claimTaskInputActor("target", body, speaker)!;
    return taskInputActor(claim, repo, origin);
  });
}

describe("task input attribution", () => {
  it("hands the exact verified actor to a private task and keeps the source separate", async () => {
    const actor = await admitted(guardian, "guardian");
    expect(actor).toEqual(guardian);
    expect(actor).not.toBe(guardian);
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it("refuses an unknown source audience", async () => {
    await withTaskInputActor(source({ audience: undefined as never }), "target", body, async () => {
      expect(() => claimTaskInputActor("target", body, speaker)).toThrow();
    });
  });

  it("preserves a visitor, never promotes them to guardian", async () => {
    expect(await admitted(visitor, "visitor:v")).toEqual(visitor);
  });

  it("has no authority without the internal scope, regardless of submitted actor/source fields", () => {
    expect(
      claimTaskInputActor("target", { ...body, actor: guardian } as typeof body, speaker),
    ).toBeUndefined();
  });

  for (const [name, target, supplied, as] of [
    ["target chat", "another", body, speaker],
    ["text", "target", { ...body, text: "different" }, speaker],
    ["skill", "target", { ...body, skillName: "other" }, speaker],
    ["speaker", "target", body, { ...speaker, id: "untrusted:agent" }],
    ["platform", "target", body, { ...speaker, platform: "discord" }],
  ] as const) {
    it(`refuses a mismatched ${name}`, async () => {
      await expect(
        withTaskInputActor(source(), "target", body, async () => {
          claimTaskInputActor(target, supplied, as);
        }),
      ).rejects.toThrow("attribution is unavailable");
    });
  }

  it("cannot replay the claim or its asynchronous ownership check", async () => {
    await withTaskInputActor(source(), "target", body, async () => {
      const claim = claimTaskInputActor("target", body, speaker)!;
      expect(() => claimTaskInputActor("target", body, speaker)).toThrow();
      await taskInputActor(claim, repository().repo, origin);
      await expect(taskInputActor(claim, repository().repo, origin)).rejects.toThrow();
    });
  });

  it("cannot reconstruct a claim from JSON", async () => {
    const getSession = rs.fn();
    await withTaskInputActor(source(), "target", body, async () => {
      const claim = claimTaskInputActor("target", body, speaker)!;
      const forged = JSON.parse(JSON.stringify(claim));
      await expect(taskInputActor(forged, { getSession }, origin)).rejects.toThrow();
      expect(getSession).not.toHaveBeenCalled();
    });
  });

  it("expires before a delayed handoff", async () => {
    rs.useFakeTimers();
    try {
      await withTaskInputActor(source(), "target", body, async () => {
        rs.advanceTimersByTime(30_000);
        expect(() => claimTaskInputActor("target", body, speaker)).toThrow();
      });
    } finally {
      rs.useRealTimers();
    }
  });

  it("revokes detached continuations when the send scope ends", async () => {
    let late!: () => ReturnType<typeof claimTaskInputActor>;
    let run!: () => void;
    const wait = new Promise<void>((resolve) => {
      run = resolve;
    });
    let continuation!: Promise<unknown>;
    await withTaskInputActor(source(), "target", body, async () => {
      late = () => claimTaskInputActor("target", body, speaker);
      continuation = wait.then(late);
    });
    run();
    await expect(continuation).rejects.toThrow();
  });

  it("rechecks revocation after an async owner lookup", async () => {
    let active = true;
    const { repo } = repository();
    await withTaskInputActor(source({ isCurrent: () => active }), "target", body, async () => {
      const claim = claimTaskInputActor("target", body, speaker)!;
      await expect(
        taskInputActor(claim, repo, async () => {
          active = false;
          return "source";
        }),
      ).rejects.toThrow();
    });
  });

  it("does not lend an outer claim to an unattributed nested send", async () => {
    await withTaskInputActor(source(), "target", body, async () => {
      await withTaskInputActor(undefined, "target", body, async () => {
        expect(claimTaskInputActor("target", body, speaker)).toBeUndefined();
      });
      expect(claimTaskInputActor("target", body, speaker)).toBeDefined();
    });
  });

  for (const reason of [
    "other owner",
    "other source",
    "ordinary chat",
    "archived",
    "unknown actor",
    "unknown issuer",
    "self target",
  ] as const) {
    it(`refuses ${reason}`, async () => {
      const { rows, repo } = repository();
      if (reason === "other owner") rows.get("target")!.ownerKey = "visitor:other";
      if (reason === "ordinary chat") rows.get("target")!.triggerKind = "";
      if (reason === "archived") Object.assign(rows.get("target")!, { archivedAt: new Date() });
      const actor = reason === "unknown actor" ? { kind: "anonymous" as const } : guardian;
      const issuer = reason === "unknown issuer" ? "unknown" : "core:concierge";
      const target = reason === "self target" ? "source" : "target";
      await expect(
        withTaskInputActor(source({ actor, agentName: issuer }), target, body, async () => {
          const claim = claimTaskInputActor(target, body, speaker)!;
          await taskInputActor(claim, repo, async () =>
            reason === "other source" ? "different-concierge" : "source",
          );
        }),
      ).rejects.toThrow();
    });
  }
});

describe("task input admission", () => {
  it("enqueues once, only after the ownership check", async () => {
    const { admitTaskInput } = await import("./task-input-actor.js");
    const enqueue = rs.fn(() => "receipt");
    await withTaskInputActor(source(), "target", body, async () => {
      const claim = claimTaskInputActor("target", body, speaker)!;
      expect(() => admitTaskInput(claim, enqueue)).toThrow();
      await taskInputActor(claim, repository().repo, origin);
      expect(admitTaskInput(claim, enqueue)).toBe("receipt");
      expect(() => admitTaskInput(claim, enqueue)).toThrow();
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses cancellation after ownership was checked but before enqueue", async () => {
    const { admitTaskInput } = await import("./task-input-actor.js");
    let active = true;
    const enqueue = rs.fn();
    await withTaskInputActor(source({ isCurrent: () => active }), "target", body, async () => {
      const claim = claimTaskInputActor("target", body, speaker)!;
      await taskInputActor(claim, repository().repo, origin);
      await Promise.resolve();
      active = false;
      expect(() => admitTaskInput(claim, enqueue)).toThrow();
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

it("does not admit an input whose ownership check failed", async () => {
  const { admitTaskInput } = await import("./task-input-actor.js");
  const enqueue = rs.fn();
  await withTaskInputActor(source(), "target", body, async () => {
    const claim = claimTaskInputActor("target", body, speaker)!;
    await expect(taskInputActor(claim, repository("visitor:other").repo, origin)).rejects.toThrow();
    expect(() => admitTaskInput(claim, enqueue)).toThrow();
  });
  expect(enqueue).not.toHaveBeenCalled();
});

it("does not reuse a prior authorization after its final ownership refresh fails", async () => {
  const { admitTaskInput, refreshTaskInputActor } = await import("./task-input-actor.js");
  const { repo, rows } = repository();
  const enqueue = rs.fn();
  await withTaskInputActor(source(), "target", body, async () => {
    const claim = claimTaskInputActor("target", body, speaker)!;
    await taskInputActor(claim, repo, origin);
    rows.get("target")!.ownerKey = "visitor:other";
    await expect(refreshTaskInputActor(claim, repo, origin)).rejects.toThrow();
    expect(() => admitTaskInput(claim, enqueue)).toThrow();
  });
  expect(enqueue).not.toHaveBeenCalled();
});

it("does not leak a spent handoff into the receiving turn's async work", async () => {
  const { admitTaskInput } = await import("./task-input-actor.js");
  await withTaskInputActor(source(), "target", body, async () => {
    const claim = claimTaskInputActor("target", body, speaker)!;
    await taskInputActor(claim, repository().repo, origin);
    await admitTaskInput(claim, async () => {
      await Promise.resolve();
      expect(claimTaskInputActor("target", body, speaker)).toBeUndefined();
    });
    expect(() => claimTaskInputActor("target", body, speaker)).toThrow();
  });
});
