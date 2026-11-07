import { expect, it } from "@rstest/core";
import { quotaSwitchTarget, sameProviderTarget, soleExhaustedProvider } from "./quota-switch.js";
import type { AIToolStateValue } from "./ai-tool-state.js";

const state = (): AIToolStateValue => ({
  claude: { loggedIn: true, quotaExhausted: true },
  codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
});
it("keeps Concierge's Luna then Terra and Sonnet choices", () => {
  const raw = state();
  expect(soleExhaustedProvider(raw)).toBe("anthropic");
  expect(quotaSwitchTarget(raw, "anthropic")?.selectionId).toBe("gpt-6-luna");
  raw.codex.lunaAccess = false;
  expect(quotaSwitchTarget(raw, "anthropic")?.selectionId).toBe("gpt-5-6-terra");
  raw.codex.quotaExhausted = true;
  expect(soleExhaustedProvider(raw)).toBeNull();
  expect(quotaSwitchTarget(raw, "anthropic")).toBeNull();
  raw.claude.quotaExhausted = false;
  expect(soleExhaustedProvider(raw)).toBe("openai");
  expect(quotaSwitchTarget(raw, "openai")?.selectionId).toBe("claude-sonnet");
  raw.codex.quotaExhausted = false;
  expect(soleExhaustedProvider(raw)).toBeNull();
  expect(quotaSwitchTarget(raw, "openai")).toBeNull();
});
it.each(["openai", "anthropic"] as const)("requires a usable subscription opposite %s", (from) => {
  const raw = state();
  raw.codex.quotaExhausted = from === "openai";
  raw.claude.quotaExhausted = from === "anthropic";
  const target = from === "openai" ? raw.claude : raw.codex;
  for (const patch of [
    { loggedIn: false },
    { loggedIn: undefined },
    { needsReauth: true },
    { quotaExhausted: true },
    ...(from === "openai"
      ? [{ authMethod: "environment" }, { authMethod: "stored-compatible" }]
      : [{ accountType: "api_key" }]),
  ]) {
    const changed = { ...raw, [from === "openai" ? "claude" : "codex"]: { ...target, ...patch } };
    expect(quotaSwitchTarget(changed, from)).toBeNull();
  }
});
it("excludes Rome credits by reading raw logged-out Codex, not resolver availability", () => {
  const raw = state();
  raw.codex.loggedIn = false;
  expect(quotaSwitchTarget(raw, "anthropic")).toBeNull();
});

it.each([
  ["anthropic", "claude-sonnet-5-5", "claude-opus-5-5"],
  ["anthropic", "claude-opus-5-5[1m]", "claude-sonnet"],
  ["anthropic", "claude-fable-5-1[1m]", "claude-sonnet"],
  ["anthropic", "claude-haiku-5-5", "claude-sonnet"],
  ["openai", "gpt-6-luna", "gpt-5-6-terra"],
  ["openai", "gpt-5.6-terra", "gpt-6-luna"],
  ["openai", "gpt-6.1-sol", "gpt-6-luna"],
] as const)("keeps %s's thread from %s on %s", (provider, model, target) => {
  const raw = state();
  raw.claude.quotaExhausted = false;
  expect(sameProviderTarget(raw, provider, model)?.selectionId).toBe(target);
});
it("requires same-provider availability and model access", () => {
  const raw = state();
  raw.claude.quotaExhausted = false;
  raw.codex.lunaAccess = false;
  expect(sameProviderTarget(raw, "openai", "gpt-5.6-terra")).toBeNull();
  expect(sameProviderTarget(raw, "openai", "gpt-6.1-sol")?.selectionId).toBe("gpt-5-6-terra");
  for (const patch of [
    { loggedIn: false },
    { needsReauth: true },
    { quotaExhausted: true },
    { authMethod: "environment" },
  ]) {
    expect(
      sameProviderTarget(
        { ...raw, claude: { ...raw.claude, ...patch } },
        "anthropic",
        "claude-sonnet",
      ),
    ).toBeNull();
  }
});
