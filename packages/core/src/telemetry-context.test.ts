import { describe, expect, it } from "@rstest/core";
import {
  currentSession,
  currentSessionId,
  enterSession,
  runWithSession,
} from "./telemetry-context.js";

describe("session context", () => {
  it("returns undefined when no session is entered", () => {
    expect(currentSessionId()).toBeUndefined();
    expect(currentSession()).toBeUndefined();
  });

  it("runWithSession binds the id for the duration of the callback", async () => {
    const seen: (string | undefined)[] = [];
    await runWithSession("s1", async () => {
      seen.push(currentSessionId());
      await Promise.resolve();
      seen.push(currentSessionId());
    });
    expect(seen).toEqual(["s1", "s1"]);
    expect(currentSessionId()).toBeUndefined();
  });

  it("enterSession persists through awaits in the same async chain", async () => {
    const results = await (async () => {
      enterSession("s2");
      const first = currentSessionId();
      await Promise.resolve();
      const second = currentSessionId();
      await new Promise((r) => setTimeout(r, 1));
      const third = currentSessionId();
      return { first, second, third };
    })();
    expect(results).toEqual({ first: "s2", second: "s2", third: "s2" });
  });

  it("documented caveat: nested enterSession in a child generator leaks across yield back to the parent", async () => {
    // This captures the raw AsyncLocalStorage + generator interaction that
    // `enterSession`'s doc comment warns about. Accepted limitation for v1:
    // after a nested agent run, the parent may observe the child's id on
    // subsequent logs until the parent itself re-enters. If Node's
    // async_hooks behavior changes and this test flips, revisit the caveat.
    async function* child() {
      enterSession("child");
      yield currentSessionId();
    }

    async function* parent() {
      enterSession("parent");
      for await (const fromChild of child()) {
        yield `child:${fromChild}`;
        yield `parent:${currentSessionId()}`;
      }
    }

    const out: string[] = [];
    for await (const m of parent()) out.push(String(m));

    expect(out).toEqual(["child:child", "parent:child"]);
  });
});
