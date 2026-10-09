import { describe, expect, it, rs } from "@rstest/core";
import type { RomeCreditsView } from "@rome/api-types/rome-credits";
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

  it("selects credits when a revoked ChatGPT login needs re-authentication", () => {
    const calls: Array<string | null> = [];
    const value = structuredClone(base);
    const payer = createRomeCreditsPayer({
      aiToolState: { get: () => value },
      appServerManager: fakeManager((p) => calls.push(p)),
      getInstanceToken: () => "romeinst_123",
      hasRomeCloud: () => true,
    });
    payer.sync();
    // markAuthRevoked's view of a revoked ChatGPT token.
    value.codex.loggedIn = false;
    value.codex.needsReauth = true;
    payer.sync();
    expect(calls).toEqual(["rome_credits"]);
  });

  describe("served models", () => {
    const view = (models?: string[]): RomeCreditsView => ({
      grantedMicros: "1",
      balanceMicros: "1",
      availableMicros: "1",
      enabled: true,
      ...(models ? { models } : {}),
    });

    function creditsPayer(fetchRomeCredits: () => Promise<RomeCreditsView | null>) {
      const value = structuredClone(base);
      let token: string | null = "romeinst_123";
      const payer = createRomeCreditsPayer({
        aiToolState: { get: () => value },
        appServerManager: fakeManager(),
        getInstanceToken: () => token,
        hasRomeCloud: () => true,
        fetchRomeCredits,
      });
      return {
        payer,
        value,
        setToken: (next: string | null) => {
          token = next;
        },
      };
    }

    it("reads the served models when credits start to pay", async () => {
      const fetch = rs.fn(async () => view(["gpt-5.6-terra"]));
      const { payer, value } = creditsPayer(fetch);
      payer.sync();
      expect(fetch).not.toHaveBeenCalled();
      expect(payer.servedModels()).toBeNull();
      value.codex.loggedIn = false;
      payer.sync();
      expect(fetch).toHaveBeenCalledTimes(1);
      await payer.refreshServedModels();
      expect(payer.servedModels()).toEqual(["gpt-5.6-terra"]);
    });

    it("does not read the served models while ChatGPT pays", async () => {
      const fetch = rs.fn(async () => view(["gpt-5.6-terra"]));
      const { payer } = creditsPayer(fetch);
      payer.sync();
      await payer.refreshServedModels();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps the last snapshot when a read fails", async () => {
      let fail = false;
      const { payer, value } = creditsPayer(async () => {
        if (fail) throw new Error("down");
        return view(["gpt-6-luna"]);
      });
      value.codex.loggedIn = false;
      payer.sync();
      await payer.refreshServedModels();
      fail = true;
      await payer.refreshServedModels();
      expect(payer.servedModels()).toEqual(["gpt-6-luna"]);
    });

    it("treats a gateway that reports no list as unknown", async () => {
      const { payer, value } = creditsPayer(async () => view());
      value.codex.loggedIn = false;
      payer.sync();
      await payer.refreshServedModels();
      expect(payer.servedModels()).toBeNull();
    });

    it("drops the snapshot and a read in flight when the credential changes", async () => {
      const answers: Array<(v: RomeCreditsView) => void> = [];
      const fetch = rs.fn(() => new Promise<RomeCreditsView>((resolve) => answers.push(resolve)));
      const { payer, value, setToken } = creditsPayer(fetch);
      value.codex.loggedIn = false;
      payer.sync();
      answers[0]?.(view(["gpt-6.1-sol"]));
      await payer.refreshServedModels();
      expect(payer.servedModels()).toEqual(["gpt-6.1-sol"]);

      const stale = payer.refreshServedModels();
      setToken("romeinst_456");
      payer.sync();
      expect(payer.servedModels()).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(3);
      answers[1]?.(view(["gpt-6.1-sol", "gpt-6-luna"]));
      await stale;
      expect(payer.servedModels()).toBeNull();
      answers[2]?.(view(["gpt-5.6-terra"]));
      await payer.refreshServedModels();
      expect(payer.servedModels()).toEqual(["gpt-5.6-terra"]);
    });
  });
});
