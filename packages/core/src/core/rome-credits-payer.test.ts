import { describe, expect, it } from "@rstest/core";
import { createRomeCreditsPayer } from "./rome-credits-payer.js";
import type { AIToolStateValue } from "./ai-tool-state.js";

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
      appServerManager: {
        setDefaultProvider: (provider) => calls.push(provider),
        restart: () => restarts++,
      },
      getInstanceToken: () => token,
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
    expect(restarts).toBe(1);
  });
});
