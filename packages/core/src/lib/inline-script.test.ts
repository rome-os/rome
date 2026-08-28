import { describe, expect, it } from "@rstest/core";
import { escapeForInlineScript } from "./inline-script.js";

describe("escapeForInlineScript", () => {
  it("emits plain JSON for benign values", () => {
    expect(escapeForInlineScript("G-ABC123")).toBe('"G-ABC123"');
    expect(escapeForInlineScript({ a: 1 })).toBe('{"a":1}');
  });

  it("neutralizes script-context breakouts while preserving the value", () => {
    const hostile = '"</script><script>alert(1)</script>';
    const escaped = escapeForInlineScript(hostile);
    expect(escaped).not.toContain("<");
    expect(JSON.parse(escaped)).toBe(hostile);
  });
});
