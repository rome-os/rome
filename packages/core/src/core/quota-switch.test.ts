import { describe, expect, it } from "@rstest/core";
import { quotaSwitchTarget, soleExhaustedProvider } from "./quota-switch.js";
import type { AIToolStateValue } from "./ai-tool-state.js";

const state = (): AIToolStateValue => ({
  codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
  claude: { loggedIn: true, quotaExhausted: true },
});

describe("quotaSwitchTarget", () => {
  it.each(["large", "medium", "small"] as const)("maps %s to an entitled Codex model", (tier) => {
    const raw = state();
    expect(quotaSwitchTarget(raw, "anthropic", tier)?.selectionId).toBe(
      tier === "small" ? "gpt-6-luna" : "gpt-6-1-sol",
    );
    raw.codex.solAccess = raw.codex.lunaAccess = false;
    expect(quotaSwitchTarget(raw, "anthropic", tier)?.selectionId).toBe("gpt-5-6-terra");
  });
  it.each([
    ["large", "claude-opus-5-5"],
    ["medium", "claude-sonnet"],
    ["small", "claude-haiku"],
  ] as const)("maps %s to %s", (tier, selectionId) => {
    const raw = state();
    raw.codex.quotaExhausted = true;
    raw.claude.quotaExhausted = false;
    expect(quotaSwitchTarget(raw, "openai", tier)).toEqual({ provider: "anthropic", selectionId });
  });
  it.each([
    "anthropic",
    "openai",
  ] as const)("requires exhaustion and a usable subscription opposite %s", (from) => {
    const raw = state();
    const source = from === "anthropic" ? raw.claude : raw.codex;
    const target = from === "anthropic" ? raw.codex : raw.claude;
    source.quotaExhausted = true;
    target.quotaExhausted = false;
    expect(quotaSwitchTarget(raw, from, "large")).not.toBeNull();
    for (const patch of [
      { loggedIn: false },
      { loggedIn: undefined },
      { quotaExhausted: true },
      { needsReauth: true },
    ]) {
      const saved = { ...target };
      Object.assign(target, patch);
      expect(quotaSwitchTarget(raw, from, "large")).toBeNull();
      Object.assign(target, { needsReauth: undefined }, saved);
    }
    source.quotaExhausted = false;
    expect(quotaSwitchTarget(raw, from, "large")).toBeNull();
  });
  it("excludes API keys and raw logged-out Codex even when Rome credits can pay", () => {
    const raw = state();
    raw.codex.accountType = "api_key";
    expect(quotaSwitchTarget(raw, "anthropic", "large")).toBeNull();
    raw.codex.accountType = undefined;
    raw.codex.loggedIn = false;
    expect(quotaSwitchTarget(raw, "anthropic", "large")).toBeNull();
    raw.codex.quotaExhausted = true;
    raw.claude.quotaExhausted = false;
    for (const authMethod of ["stored-compatible", "environment"] as const) {
      raw.claude.authMethod = authMethod;
      expect(quotaSwitchTarget(raw, "openai", "large")).toBeNull();
    }
  });
  it("keeps Concierge's Sonnet and Luna then Terra order", () => {
    const raw = state();
    expect(quotaSwitchTarget(raw, "anthropic", "large", true)?.selectionId).toBe("gpt-6-luna");
    raw.codex.lunaAccess = false;
    expect(quotaSwitchTarget(raw, "anthropic", "large", true)?.selectionId).toBe("gpt-5-6-terra");
    raw.codex.quotaExhausted = true;
    raw.claude.quotaExhausted = false;
    expect(quotaSwitchTarget(raw, "openai", "small", true)?.selectionId).toBe("claude-sonnet");
  });
});

describe("soleExhaustedProvider", () => {
  it("names a provider only when exactly one is out of quota", () => {
    const raw = state();
    expect(soleExhaustedProvider(raw)).toBe("anthropic");
    raw.codex.quotaExhausted = true;
    expect(soleExhaustedProvider(raw)).toBeNull();
    raw.claude.quotaExhausted = false;
    expect(soleExhaustedProvider(raw)).toBe("openai");
    raw.codex.quotaExhausted = false;
    expect(soleExhaustedProvider(raw)).toBeNull();
  });
});
