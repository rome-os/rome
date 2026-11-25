import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { DashboardAccessState } from "./dashboard-access-state.js";
import { ENTRY_RECHECK_MS, holdEntry, mayEnter } from "./entry.js";

const member = { kind: "visitor", accountId: "ada", email: "ada@example.com" } as const;
const guest = { kind: "visitor", accountId: "guest", email: "guest@example.com" } as const;
const guardian = { kind: "guardian", userId: "owner", via: "cookie" } as const;

describe("mayEnter", () => {
  it("lets in the guardian and whoever the allow-list names, and no one else", async () => {
    const allowList = new DashboardAccessState();
    allowList.setCloudEmailAccess(["ada@example.com"]);
    expect(await mayEnter(guardian, allowList)).toEqual(guardian);
    expect(await mayEnter({ ...guardian, via: "loopback" }, allowList)).toEqual({
      ...guardian,
      via: "loopback",
    });
    expect(await mayEnter(member, allowList)).toEqual(member);
    expect(await mayEnter(guest, allowList)).toBeNull();
    expect(await mayEnter({ kind: "anonymous" }, allowList)).toBeNull();
    expect(await mayEnter(undefined, allowList)).toBeNull();
  });
});

describe("holdEntry", () => {
  let allowed: boolean;
  let lost: number;
  let taken: string[];
  const hold = () => {
    const entry = holdEntry(
      async () => allowed,
      () => {
        lost += 1;
      },
    );
    const input = (name: string) => entry.admit(() => void taken.push(name));
    return { entry, input };
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 5));

  beforeEach(() => {
    rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    allowed = true;
    lost = 0;
    taken = [];
  });
  afterEach(() => {
    rs.useRealTimers();
  });

  it("takes inputs in order while the person may enter", async () => {
    const { input } = hold();
    for (const name of ["a", "b", "c"]) input(name);
    rs.advanceTimersByTime(ENTRY_RECHECK_MS * 3);
    await settled();
    expect([taken, lost]).toEqual([["a", "b", "c"], 0]);
  });

  it("finds a lost entry at the recheck, within 30 seconds", async () => {
    expect(ENTRY_RECHECK_MS).toBeLessThan(30_000);
    hold();
    allowed = false;
    rs.advanceTimersByTime(ENTRY_RECHECK_MS);
    await settled();
    expect(lost).toBe(1);
  });

  it("finds a lost entry at the next input, and stays lost when the person is back", async () => {
    const { input } = hold();
    allowed = false;
    input("refused");
    await settled();
    allowed = true;
    input("back");
    rs.advanceTimersByTime(ENTRY_RECHECK_MS * 2);
    await settled();
    expect([taken, lost]).toEqual([[], 1]);
  });

  it("takes nothing when the check fails", async () => {
    const taken: string[] = [];
    const entry = holdEntry(
      () => Promise.reject(new Error("no answer")),
      () => void taken.push("lost"),
    );
    entry.admit(() => void taken.push("input"));
    await settled();
    expect(taken).toEqual(["lost"]);
  });

  it("survives an onLost that throws, at the recheck too", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => void rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const entry = holdEntry(
        async () => false,
        () => {
          throw new Error("cannot close");
        },
      );
      rs.advanceTimersByTime(ENTRY_RECHECK_MS);
      await settled();
      expect(await entry.holds()).toBe(false);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("keeps taking inputs after one fails", async () => {
    const { entry, input } = hold();
    entry.admit(() => {
      throw new Error("bad input");
    });
    input("next");
    await settled();
    expect(taken).toEqual(["next"]);
  });

  it("tells no one after its connection closed", async () => {
    const { entry, input } = hold();
    entry.release();
    allowed = false;
    input("late");
    rs.advanceTimersByTime(ENTRY_RECHECK_MS * 2);
    await settled();
    expect([taken, lost]).toEqual([[], 0]);
  });
});
