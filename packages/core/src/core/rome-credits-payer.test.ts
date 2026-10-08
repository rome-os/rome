import { describe, expect, it } from "@rstest/core";
import { createRomeCreditsPayer } from "./rome-credits-payer.js";
import type { AIToolStateValue } from "./ai-tool-state.js";

function fakeManager(onSet: (provider: string | null) => void = () => {}, onRestart = () => {}) {
  let provider: string | null = null;
  return {
    getDefaultProvider: () => provider,
    setDefaultProvider: (next: string | null) => {
      provider = next;
      onSet(next);
    },
    restart: onRestart,
  };
}

const base: AIToolStateValue = {
  codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
  claude: { loggedIn: false, quotaExhausted: false },
};

describe("Rome credits payer", () => {
  it("selects credits only while ChatGPT is disconnected", () => {
    const calls: Array<string | null> = [];
    let restarts = 0;
    const value = structuredClone(base);
    let token: string | null = "romeinst_123";
    const payer = createRomeCreditsPayer({
      aiToolState: { get: () => value },
      appServerManager: fakeManager(
        (provider) => calls.push(provider),
        () => restarts++,
      ),
      getInstanceToken: () => token,
      hasRomeCloud: () => true,
    });
    payer.sync();
    expect(calls).toEqual([]);
    value.codex.quotaExhausted = true;
    payer.sync();
    expect(calls).toEqual([]);
    value.codex.loggedIn = false;
    payer.sync();
    expect(calls).toEqual(["rome_credits"]);
    value.codex.quotaExhausted = false;
    payer.sync();
    expect(calls).toEqual(["rome_credits"]);
    value.codex.loggedIn = true;
    payer.sync();
    expect(calls).toEqual(["rome_credits", null]);
    token = "romeinst_456";
    payer.sync();
    expect(calls).toEqual(["rome_credits", null]);
    expect(restarts).toBe(0);
  });

  it("restarts on a token change only while credits pay", () => {
    let restarts = 0;
    const value = structuredClone(base);
    value.codex.loggedIn = false;
    let token: string | null = "romeinst_123";
    const payer = createRomeCreditsPayer({
      aiToolState: { get: () => value },
      appServerManager: fakeManager(undefined, () => restarts++),
      getInstanceToken: () => token,
      hasRomeCloud: () => true,
    });
    payer.sync();
    token = "romeinst_456";
    payer.sync();
    expect(restarts).toBe(1);
  });

  it("keeps the ChatGPT default without a Rome Cloud origin", () => {
    const calls: Array<string | null> = [];
    const value = structuredClone(base);
    value.codex.loggedIn = false;
    const payer = createRomeCreditsPayer({
      aiToolState: { get: () => value },
      appServerManager: fakeManager((p) => calls.push(p)),
      getInstanceToken: () => "romeinst_123",
      hasRomeCloud: () => false,
    });
    payer.sync();
    expect(calls).toEqual([]);
    expect(payer.isUsingRomeCredits()).toBe(false);
  });
});
