import { describe, expect, it } from "@rstest/core";
import { usageProvider } from "./usage-provider";
import type { AIToolsStatus } from "@rome/api-types/ai-tools";

const both: AIToolsStatus = { codex: { loggedIn: true }, claude: { loggedIn: true } };
describe("usage provider", () => {
  it("uses an explicit pick before a concrete pin", () => {
    expect(usageProvider("claude-opus-5-5", "gpt-6.1-sol", both)).toBe("anthropic");
    expect(usageProvider("gpt-6-astra", "claude-opus-5-5[1m]", both)).toBe("openai");
  });
  it("keeps the existing chat pin on Auto, even when that provider is exhausted", () => {
    expect(usageProvider("auto", "claude-opus-5-5[1m]", both)).toBe("anthropic");
    expect(
      usageProvider("auto", "gpt-6.1-sol", {
        ...both,
        codex: { loggedIn: true, quotaExhausted: true },
      }),
    ).toBe("openai");
  });
  it("shares the resolver's Auto priority only when there is no pin", () => {
    expect(usageProvider("auto", null, both)).toBe("openai");
    expect(usageProvider("auto", null, { ...both, codex: { loggedIn: false } })).toBe("anthropic");
    expect(
      usageProvider("auto", null, { ...both, codex: { loggedIn: true, quotaExhausted: true } }),
    ).toBe("anthropic");
    expect(
      usageProvider("auto", null, { codex: { loggedIn: false }, claude: { loggedIn: false } }),
    ).toBeNull();
    expect(usageProvider("auto", "custom-model", both)).toBeNull();
  });
});
