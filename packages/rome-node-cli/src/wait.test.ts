import { describe, expect, it } from "@rstest/core";
import { actionError, type ActionResponse } from "@rome-os/node-core";
import { parseWait, untilConnected } from "./wait.js";

const offline = actionError("target_unavailable", "The Gateway could not forward the request.");
const ok: ActionResponse = { type: "response", ok: true, result: { steps: 4200 } };

/** A clock that moves only when the caller sleeps, and replies from a script. */
function scripted(replies: ActionResponse[]) {
  let now = 0;
  const sleeps: number[] = [];
  let calls = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  const attempt = async () => replies[Math.min(calls++, replies.length - 1)];
  return { clock, attempt, sleeps, calls: () => calls };
}

describe("untilConnected", () => {
  it("answers once the device connects, after asking again while it was offline", async () => {
    const s = scripted([offline, offline, ok]);
    expect(await untilConnected(s.attempt, (r) => r, 120, s.clock)).toEqual(ok);
    expect(s.calls()).toBe(3);
    expect(s.sleeps).toEqual([2000, 2000]);
  });

  it("returns target_unavailable when the device stays offline past the wait", async () => {
    const s = scripted([offline]);
    expect(await untilConnected(s.attempt, (r) => r, 5, s.clock)).toEqual(offline);
    expect(s.sleeps).toEqual([2000, 2000, 1000]);
  });

  it("asks once without a wait", async () => {
    const s = scripted([offline, ok]);
    expect(await untilConnected(s.attempt, (r) => r, undefined, s.clock)).toEqual(offline);
    expect(s.calls()).toBe(1);
  });

  it("never asks again after a request that may have run", async () => {
    const unknown = actionError("unknown_outcome", "Execution may have occurred.");
    const s = scripted([unknown, ok]);
    expect(await untilConnected(s.attempt, (r) => r, 120, s.clock)).toEqual(unknown);
    expect(s.calls()).toBe(1);
  });
});

describe("parseWait", () => {
  it("accepts whole seconds from 1 to 900", () => {
    expect(parseWait(undefined)).toBeUndefined();
    expect(parseWait("120")).toBe(120);
    for (const bad of ["0", "901", "1.5", "-3", "soon", ""])
      expect(() => parseWait(bad)).toThrow("--wait must be");
  });
});
