import { expect, it } from "@rstest/core";
import { quotaSwitchTarget, soleExhaustedProvider } from "./quota-switch.js";
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
