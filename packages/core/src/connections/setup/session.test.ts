// Seams under test: the SetupSession public interface — `state`, `started()`,
// `provideInput`, `provideReturn`, `cancel` — driving a builder-written
// `setup(interact, ctx)` coroutine and observing the poll-able state. No test
// reaches into the pump's internals.

import { describe, expect, it, rs } from "@rstest/core";
import { SetupSession } from "./session.js";
import type { SetupConferral, SetupFn } from "./types.js";

const CRED: SetupConferral["credential"] = { material: { token: "t" }, expiresAt: "never" };

/** A deferred promise handle for driving in-coroutine external waits from tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SetupSession", () => {
  it("suspends at prompt, exposing the awaiting-input form", async () => {
    const fn: SetupFn = async (interact) => {
      await interact.prompt({ fields: [{ name: "token", label: "Token", secret: true }] });
      return { credential: CRED };
    };
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();
    expect(session.state).toEqual({
      status: "awaiting-input",
      form: { fields: [{ name: "token", label: "Token", secret: true }] },
    });
  });

  it("resumes the coroutine with the guardian's answers on provideInput", async () => {
    const seen: Record<string, string>[] = [];
    const fn: SetupFn = async (interact) => {
      const answers = await interact.prompt({
        fields: [{ name: "token", label: "Token", secret: true }],
      });
      seen.push(answers);
      return { credential: CRED };
    };
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });
    await session.started();
    const outcome = await session.provideInput({ token: "abc" });
    expect(outcome.accepted).toBe(true);
    expect(seen).toEqual([{ token: "abc" }]);
    expect(session.state.status).toBe("done");
  });

  it("re-prompts with a validation error, carrying the error on the state", async () => {
    const fn: SetupFn = async (interact) => {
      let error: string | undefined;
      for (;;) {
        const { token } = await interact.prompt({
          fields: [{ name: "token", label: "Token", secret: true }],
          ...(error ? { error } : {}),
        });
        if (token === "good") break;
        error = "That token was rejected.";
      }
      return { credential: CRED };
    };
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();

    const first = await session.provideInput({ token: "bad" });
    expect(first.accepted).toBe(true);
    expect(first.state).toEqual({
      status: "awaiting-input",
      form: { fields: [{ name: "token", label: "Token", secret: true }] },
      error: "That token was rejected.",
    });

    const second = await session.provideInput({ token: "good" });
    expect(second.state.status).toBe("done");
  });

  it("presents a shown view non-blocking, then keeps presenting it during a ctx.step wait", async () => {
    const gate = deferred<void>();
    const fn: SetupFn = async (interact, ctx) => {
      await interact.prompt({ fields: [{ name: "token", label: "Token", secret: true }] });
      interact.show({ title: "Verify", body: ["Message the bot"], progress: true });
      await ctx.step("guardian-link", () => gate.promise);
      return { credential: CRED };
    };
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();
    const outcome = await session.provideInput({ token: "abc" });
    // Settled at the ctx.step wait, presenting the last shown view.
    expect(outcome.state).toEqual({
      status: "presenting",
      view: { title: "Verify", body: ["Message the bot"], progress: true },
    });
    gate.resolve();
  });

  it("runs commit exactly once with the returned conferral, and only then reports done", async () => {
    const commitGate = deferred<void>();
    const commit = rs.fn(async (_conferral: SetupConferral, _signal: AbortSignal) => {
      await commitGate.promise;
    });
    const conferral: SetupConferral = {
      credential: CRED,
      profile: { botUsername: "rome" },
      guardianChannelUserId: "guardian-123",
      summary: { title: "Connected" },
    };
    const fn: SetupFn = async (interact) => {
      await interact.prompt({ fields: [{ name: "token", label: "Token", secret: true }] });
      return conferral;
    };
    const session = new SetupSession({ fn, commit });

    await session.started();
    const inputDone = session.provideInput({ token: "abc" });
    // Commit is in flight; done must NOT be observable yet.
    await Promise.resolve();
    expect(session.state.status).not.toBe("done");

    commitGate.resolve();
    const outcome = await inputDone;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toBe(conferral);
    expect(outcome.state).toEqual({
      status: "done",
      conferral: { summary: { title: "Connected" } },
    });
  });

  it("interrupts an in-flight ctx.step wait on cancel and runs no commit", async () => {
    const commit = rs.fn(async () => {});
    let stepSignal: AbortSignal | undefined;
    const neverResolves = deferred<void>();
    const fn: SetupFn = async (interact, ctx) => {
      await interact.prompt({ fields: [{ name: "token", label: "Token", secret: true }] });
      await ctx.step("guardian-link", (signal) => {
        stepSignal = signal;
        return neverResolves.promise; // ignores the signal on purpose
      });
      return { credential: CRED };
    };
    const session = new SetupSession({ fn, commit });
    await session.started();
    await session.provideInput({ token: "abc" });
    expect(session.state.status).toBe("presenting");

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    // The step's fn received a real signal that is now aborted (defense-in-depth).
    expect(stepSignal?.aborted).toBe(true);
  });

  it("cancels a coroutine suspended at prompt, running no commit", async () => {
    const commit = rs.fn(async () => {});
    const fn: SetupFn = async (interact) => {
      await interact.prompt({ fields: [{ name: "token", label: "Token", secret: true }] });
      return { credential: CRED };
    };
    const session = new SetupSession({ fn, commit });
    await session.started();
    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects input when not awaiting input (late/double delivery)", async () => {
    const fn: SetupFn = async (interact) => {
      await interact.prompt({ fields: [{ name: "token", label: "Token", secret: true }] });
      return { credential: CRED };
    };
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();
    await session.provideInput({ token: "abc" }); // consumes the only prompt
    const late = await session.provideInput({ token: "again" });
    expect(late.accepted).toBe(false);
    expect(late.reason).toBeDefined();
  });

  it("fails the setup (no cancelled state) when commit throws", async () => {
    const commit = rs.fn(async () => {
      throw new Error("ledger write failed");
    });
    const fn: SetupFn = async (interact) => {
      await interact.prompt({ fields: [{ name: "token", label: "Token", secret: true }] });
      return { credential: CRED };
    };
    const session = new SetupSession({ fn, commit });
    await session.started();
    const outcome = await session.provideInput({ token: "abc" });
    expect(outcome.state).toEqual({ status: "failed", reason: "ledger write failed" });
  });

  it("suspends at redirect and resumes with the return-leg payload", async () => {
    const seen: Record<string, string>[] = [];
    const fn: SetupFn = async (interact) => {
      const payload = await interact.redirect("https://example.com/oauth");
      seen.push(payload);
      return { credential: CRED };
    };
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();
    expect(session.state).toEqual({
      status: "awaiting-redirect",
      url: "https://example.com/oauth",
    });
    const outcome = await session.provideReturn({ code: "xyz" });
    expect(outcome.accepted).toBe(true);
    expect(seen).toEqual([{ code: "xyz" }]);
  });
});
