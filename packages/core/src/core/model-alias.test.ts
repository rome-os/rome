import { describe, expect, it } from "@rstest/core";
import { matchesModelAlias } from "./model-alias.js";

describe("matchesModelAlias", () => {
  it.each([
    // Exact model, case-insensitively.
    ["gpt-6-sol", "gpt-6-sol"],
    ["GPT-6-SOL", "gpt-6-sol"],
    ["gpt-6-sol", "GPT-6-SOL"],
    ["gpt-6-luna", "gpt-6-luna"],
    // Effort suffix after a colon.
    ["gpt-6-sol:high", "gpt-6-sol"],
    ["GPT-6-Luna:Low", "gpt-6-luna"],
    // Dated snapshot suffix.
    ["gpt-6-sol-2026-09-01", "gpt-6-sol"],
    ["gpt-6-luna-2026-01-31", "gpt-6-luna"],
    // Dated snapshot plus an effort suffix.
    ["gpt-6-sol-2026-09-01:high", "gpt-6-sol"],
    ["gpt-6-luna-2026-01-31:low", "gpt-6-luna"],
  ])("accepts %q as an alias of %q", (model, base) => {
    expect(matchesModelAlias(model, base)).toBe(true);
  });

  it.each([
    // A different model entirely.
    ["gpt-6-luna", "gpt-6-sol"],
    ["gpt-5.6-terra", "gpt-6-sol"],
    ["", "gpt-6-sol"],
    // Same stem but no alias separator: neither exact, colon, nor dated.
    ["gpt-6-solx", "gpt-6-sol"],
    ["gpt-6-sol-", "gpt-6-sol"],
    ["gpt-6-sol-latest", "gpt-6-sol"],
    ["gpt-6-sol-2026-1-1", "gpt-6-sol"],
    ["gpt-6-sol-2026-09-01-extra", "gpt-6-sol"],
    ["gpt-6-sol-2026-09-01:", "gpt-6-sol"],
    // The base must match fully; a longer base does not alias a shorter model.
    ["gpt-6-sol", "gpt-6-sol-2026-09-01"],
  ])("rejects %q as an alias of %q", (model, base) => {
    expect(matchesModelAlias(model, base)).toBe(false);
  });
});
