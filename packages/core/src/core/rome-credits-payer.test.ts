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

const view = (overrides: Partial<RomeCreditsView> = {}): RomeCreditsView => ({
  grantedMicros: "5000000",
  balanceMicros: "5000000",
  availableMicros: "5000000",
  enabled: true,
  ...overrides,
});

function creditsPayer(
  fetchRomeCredits: () => Promise<RomeCreditsView | null> = async () => view(),
  hooks: { onSet?: (provider: string | null) => void; onRestart?: () => void } = {},
) {
  const value = structuredClone(base);
  let token: string | null = "romeinst_123";
  let romeCloud = true;
  const payer = createRomeCreditsPayer({
    aiToolState: { get: () => value },
    appServerManager: fakeManager(hooks.onSet, hooks.onRestart),
    getInstanceToken: () => token,
    hasRomeCloud: () => romeCloud,
    fetchRomeCredits,
  });
  return {
    payer,
    value,
    setToken: (next: string | null) => {
      token = next;
    },
    setRomeCloud: (next: boolean) => {
      romeCloud = next;
    },
  };
}

describe("Rome credits payer", () => {
  it("selects credits only while ChatGPT is disconnected", async () => {
    const calls: Array<string | null> = [];
    let restarts = 0;
    const { payer, value, setToken } = creditsPayer(undefined, {
      onSet: (provider) => calls.push(provider),
      onRestart: () => restarts++,
    });
    payer.sync();
    value.codex.quotaExhausted = true;
    payer.sync();
    await payer.settled();
    expect(calls).toEqual([]);
    value.codex.loggedIn = false;
    payer.sync();
    await payer.settled();
    expect(calls).toEqual(["rome_credits"]);
    value.codex.quotaExhausted = false;
    payer.sync();
    await payer.settled();
    expect(calls).toEqual(["rome_credits"]);
    value.codex.loggedIn = true;
    payer.sync();
    expect(calls).toEqual(["rome_credits", null]);
    setToken("romeinst_456");
    payer.sync();
    expect(calls).toEqual(["rome_credits", null]);
    expect(restarts).toBe(0);
  });

  it("restarts on a token change only while credits pay", async () => {
    let restarts = 0;
    const { payer, value, setToken } = creditsPayer(undefined, { onRestart: () => restarts++ });
    value.codex.loggedIn = false;
    payer.sync();
    await payer.settled();
    setToken("romeinst_456");
    payer.sync();
    expect(restarts).toBe(1);
  });

  it("keeps the ChatGPT default without a Rome Cloud origin", async () => {
    const fetch = rs.fn(async () => view());
    const calls: Array<string | null> = [];
    const { payer, value, setRomeCloud } = creditsPayer(fetch, { onSet: (p) => calls.push(p) });
    setRomeCloud(false);
    value.codex.loggedIn = false;
    payer.sync();
    await payer.settled();
    expect(calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(payer.isUsingRomeCredits()).toBe(false);
  });

  it("selects credits when a revoked ChatGPT login needs re-authentication", async () => {
    const calls: Array<string | null> = [];
    const { payer, value } = creditsPayer(undefined, { onSet: (p) => calls.push(p) });
    payer.sync();
    // markAuthRevoked's view of a revoked ChatGPT token.
    value.codex.loggedIn = false;
    value.codex.needsReauth = true;
    payer.sync();
    await payer.settled();
    expect(calls).toEqual(["rome_credits"]);
  });

  describe("balance", () => {
    it.each([
      ["no grant", null],
      ["inference disabled", view({ enabled: false })],
      ["a used-up balance", view({ balanceMicros: "0", availableMicros: "0" })],
      ["an overrun", view({ balanceMicros: "-1200", availableMicros: "-1200" })],
    ])("does not select credits for %s", async (_label, answer) => {
      const calls: Array<string | null> = [];
      const { payer, value } = creditsPayer(async () => answer, {
        onSet: (p) => calls.push(p),
      });
      value.codex.loggedIn = false;
      payer.sync();
      await payer.settled();
      expect(calls).toEqual([]);
      expect(payer.isUsingRomeCredits()).toBe(false);
    });

    it("selects credits only once the first read finds a balance", async () => {
      let answer: ((v: RomeCreditsView) => void) | undefined;
      const { payer, value } = creditsPayer(
        () => new Promise<RomeCreditsView>((resolve) => (answer = resolve)),
      );
      value.codex.loggedIn = false;
      payer.sync();
      expect(payer.isUsingRomeCredits()).toBe(false);
      answer?.(view());
      await payer.settled();
      expect(payer.isUsingRomeCredits()).toBe(true);
    });

    it("starts paying on a refresh after a grant arrives", async () => {
      let granted = false;
      const { payer, value } = creditsPayer(async () => (granted ? view() : null));
      value.codex.loggedIn = false;
      payer.sync();
      await payer.settled();
      expect(payer.isUsingRomeCredits()).toBe(false);
      granted = true;
      await payer.refresh();
      expect(payer.isUsingRomeCredits()).toBe(true);
    });

    it("stops paying on a refresh after the balance runs out", async () => {
      let available = "5000000";
      const calls: Array<string | null> = [];
      const { payer, value } = creditsPayer(async () => view({ availableMicros: available }), {
        onSet: (p) => calls.push(p),
      });
      value.codex.loggedIn = false;
      payer.sync();
      await payer.settled();
      available = "0";
      await payer.refresh();
      expect(calls).toEqual(["rome_credits", null]);
      expect(payer.servedModels()).toBeNull();
    });

    it("stops paying when the gateway rejects the credential", async () => {
      let rejected = false;
      const { payer, value } = creditsPayer(async () =>
        rejected ? null : view({ models: ["gpt-5.6-terra"] }),
      );
      value.codex.loggedIn = false;
      payer.sync();
      await payer.settled();
      rejected = true;
      await payer.refresh();
      expect(payer.isUsingRomeCredits()).toBe(false);
      expect(payer.servedModels()).toBeNull();
    });

    it("keeps the payer and snapshot when a read fails", async () => {
      let fail = false;
      const { payer, value } = creditsPayer(async () => {
        if (fail) throw new Error("down");
        return view({ models: ["gpt-6-luna"] });
      });
      value.codex.loggedIn = false;
      payer.sync();
      await payer.settled();
      fail = true;
      await payer.refresh();
      expect(payer.isUsingRomeCredits()).toBe(true);
      expect(payer.servedModels()).toEqual(["gpt-6-luna"]);
    });

    it("ignores a read that ChatGPT signing in overtook", async () => {
      let answer: ((v: RomeCreditsView) => void) | undefined;
      const { payer, value } = creditsPayer(
        () => new Promise<RomeCreditsView>((resolve) => (answer = resolve)),
      );
      value.codex.loggedIn = false;
      payer.sync();
      value.codex.loggedIn = true;
      payer.sync();
      answer?.(view());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(payer.isUsingRomeCredits()).toBe(false);
    });
  });

  describe("served models", () => {
    it("reads the served models when ChatGPT disconnects", async () => {
      const fetch = rs.fn(async () => view({ models: ["gpt-5.6-terra"] }));
      const { payer, value } = creditsPayer(fetch);
      payer.sync();
      expect(fetch).not.toHaveBeenCalled();
      expect(payer.servedModels()).toBeNull();
      value.codex.loggedIn = false;
      payer.sync();
      expect(fetch).toHaveBeenCalledTimes(1);
      await payer.settled();
      expect(payer.servedModels()).toEqual(["gpt-5.6-terra"]);
    });

    it("does not read while ChatGPT pays", async () => {
      const fetch = rs.fn(async () => view({ models: ["gpt-5.6-terra"] }));
      const { payer } = creditsPayer(fetch);
      payer.sync();
      await payer.refresh();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("waits only for the first read of a credits period", async () => {
      const answers: Array<(v: RomeCreditsView) => void> = [];
      const { payer, value } = creditsPayer(
        () => new Promise<RomeCreditsView>((resolve) => answers.push(resolve)),
      );
      value.codex.loggedIn = false;
      payer.sync();
      answers[0]?.(view());
      await payer.settled();
      const later = payer.refresh();
      let settled = false;
      await payer.settled().then(() => (settled = true));
      expect(settled).toBe(true);
      answers[1]?.(view());
      await later;
    });

    it("drops the snapshot when ChatGPT starts paying", async () => {
      const { payer, value } = creditsPayer(async () => view({ models: ["gpt-5.6-terra"] }));
      value.codex.loggedIn = false;
      payer.sync();
      await payer.settled();
      expect(payer.servedModels()).toEqual(["gpt-5.6-terra"]);
      value.codex.loggedIn = true;
      payer.sync();
      expect(payer.servedModels()).toBeNull();
    });

    it("treats a gateway that reports no list as unknown", async () => {
      const { payer, value } = creditsPayer(async () => view());
      value.codex.loggedIn = false;
      payer.sync();
      await payer.settled();
      expect(payer.isUsingRomeCredits()).toBe(true);
      expect(payer.servedModels()).toBeNull();
    });

    it("drops the snapshot and a read in flight when the credential changes", async () => {
      const answers: Array<(v: RomeCreditsView) => void> = [];
      const fetch = rs.fn(() => new Promise<RomeCreditsView>((resolve) => answers.push(resolve)));
      const { payer, value, setToken } = creditsPayer(fetch);
      value.codex.loggedIn = false;
      payer.sync();
      answers[0]?.(view({ models: ["gpt-6.1-sol"] }));
      await payer.settled();
      expect(payer.servedModels()).toEqual(["gpt-6.1-sol"]);

      const stale = payer.refresh();
      setToken("romeinst_456");
      payer.sync();
      expect(payer.servedModels()).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(3);
      answers[1]?.(view({ models: ["gpt-6.1-sol", "gpt-6-luna"] }));
      await stale;
      expect(payer.servedModels()).toBeNull();
      answers[2]?.(view({ models: ["gpt-5.6-terra"] }));
      await payer.settled();
      expect(payer.servedModels()).toEqual(["gpt-5.6-terra"]);
    });
  });
});
