import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { DashboardAccessState } from "./dashboard-access-state.js";
import { ENTRY_RECHECK_MS, holdEntry } from "./held-entry.js";

const member = { kind: "visitor", accountId: "ada", email: "ada@example.com" } as const;
const guardian = { kind: "guardian", userId: "owner", via: "cookie" } as const;

describe("holdEntry", () => {
  let allowList: DashboardAccessState;
  let lost: number;
  const onLost = () => {
    lost += 1;
  };
  const recheck = () => rs.advanceTimersByTimeAsync(ENTRY_RECHECK_MS);

  beforeEach(() => {
    rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    allowList = new DashboardAccessState();
    allowList.setCloudEmailAccess(["ada@example.com"]);
    lost = 0;
  });
  afterEach(() => {
    rs.useRealTimers();
  });

  it("keeps a member's entry while they are one, and loses it once", async () => {
    holdEntry(member, allowList, onLost);
    await recheck();
    expect(lost).toBe(0);
    allowList.setCloudEmailAccess([]);
    await recheck();
    expect(lost).toBe(1);
    await recheck();
    expect(lost).toBe(1);
  });

  it("loses the entry when the check fails", async () => {
    const failing = {
      isCloudEmailAllowed: () => {
        throw new Error("unreadable");
      },
    };
    holdEntry(member, failing, onLost);
    await recheck();
    expect(lost).toBe(1);
  });

  it("outlives an onLost that throws", async () => {
    holdEntry(member, allowList, () => {
      onLost();
      throw new Error("already closed");
    });
    allowList.setCloudEmailAccess([]);
    await recheck();
    await recheck();
    expect(lost).toBe(1);
  });

  it("asks nothing once released", async () => {
    const release = holdEntry(member, allowList, onLost);
    allowList.setCloudEmailAccess([]);
    rs.advanceTimersByTime(ENTRY_RECHECK_MS);
    release();
    await recheck();
    expect(lost).toBe(0);
  });

  it("never ends the guardian's", async () => {
    holdEntry(guardian, allowList, onLost);
    allowList.setCloudEmailAccess([]);
    await recheck();
    expect(lost).toBe(0);
  });
});
