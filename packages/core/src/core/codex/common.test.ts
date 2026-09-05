import { describe, expect, it } from "@rstest/core";
import { buildOpenAiAccounting, type Usage } from "./common.js";

describe("buildOpenAiAccounting", () => {
  it("normalizes Codex SDK input tokens to the uncached Claude-style shape", () => {
    const accounting = buildOpenAiAccounting({
      model: "gpt-5.4",
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 300,
        cache_write_input_tokens: 200,
        output_tokens: 40,
        reasoning_output_tokens: 15,
      },
    });

    expect(accounting.usage).toEqual({
      inputTokens: 500,
      outputTokens: 40,
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
    });
    expect(accounting.rawUsage).toEqual({
      input_tokens: 1000,
      uncached_input_tokens: 500,
      output_tokens: 40,
      cached_tokens: 300,
      cache_write_tokens: 200,
      reasoning_tokens: 15,
    });
  });

  it("does not emit negative uncached input tokens when SDK cache counts exceed input", () => {
    const usage: Usage = {
      input_tokens: 50,
      cached_input_tokens: 80,
      cache_write_input_tokens: 10,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    };

    const accounting = buildOpenAiAccounting({
      model: "gpt-5.4",
      usage,
    });

    expect(accounting.usage.inputTokens).toBe(0);
    expect(accounting.usage.cacheReadTokens).toBe(80);
  });

  it("normalizes legacy effort-suffixed model ids in accounting rows", () => {
    const accounting = buildOpenAiAccounting({
      model: "gpt-5.4:medium",
      usage: undefined,
    });

    expect(accounting.model).toBe("gpt-5.4");
  });
});
