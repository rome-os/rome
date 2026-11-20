import { describe, expect, it } from "@rstest/core";
import { SlackReadGate } from "./read-gate.js";

const MINUTE = 60_000;

/** A gate on a clock the test moves, whose waits end when the test says. */
function gateOnClock() {
  const clock = { t: 0 };
  const waits: { ms: number; end: () => void }[] = [];
  const gate = new SlackReadGate({
    intervalMs: MINUTE,
    maxWaitMs: MINUTE,
    now: () => clock.t,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        waits.push({ ms, end: resolve });
      }),
  });
  return { clock, waits, gate };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SlackReadGate", () => {
  it("gives a refused read's turn back, so the next read asks a minute after Slack last answered", async () => {
    const { clock, waits, gate } = gateOnClock();
    const answerA = deferred<string>();
    const a = gate.run("a", () => answerA.promise);
    clock.t = 1_000;
    const b = gate.run("b", async () => "b");
    await flush();
    // Slack answers A late, so B, booked at 60 s, would wait past its deadline.
    clock.t = 20_000;
    answerA.resolve("a");
    await a;
    clock.t = MINUTE;
    waits.shift()?.end();
    await expect(b).rejects.toThrow("Could not read these messages yet");

    void gate.run("c", async () => "c");
    // C asks at 80 s, a minute after A's answer, not at B's booking of 120 s.
    expect(waits.map((wait) => wait.ms)).toEqual([20_000]);
  });

  it("keeps the turns of a read booked behind one that is refused", async () => {
    const { clock, waits, gate } = gateOnClock();
    const answerA = deferred<string>();
    const a = gate.run("a", () => answerA.promise);
    clock.t = 1_000;
    const b = gate.run("b", async () => "b");
    await flush();
    clock.t = 20_000;
    answerA.resolve("a");
    await a;
    clock.t = MINUTE;
    // D books the turn after B's, at 120 s, before B is refused.
    void gate.run("d", async () => "d");
    waits.shift()?.end();
    await expect(b).rejects.toThrow("Could not read these messages yet");

    // B's turn stays taken, so a new read would wait past its limit.
    await expect(gate.run("c", async () => "c")).rejects.toThrow("Try again in 120 seconds");
  });
});
