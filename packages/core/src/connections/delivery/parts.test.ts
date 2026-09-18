import { describe, expect, it } from "@rstest/core";
import { partBoundary } from "./parts.js";
import { discordPlainTextCodec } from "../../channels/discord.js";
import type { TextCodec } from "./transport.js";

describe("physical source boundaries", () => {
  it.each([
    discordPlainTextCodec,
    {
      render: (source: string, settled: boolean) => `[${source}]${settled ? "!" : ""}`,
      length: (text: string) => text.length,
    } satisfies TextCodec,
  ])("measures rendered frames without putting decorations into source offsets", (codec) => {
    const source = "中文😀 **bold** `code` https://example.com\nnext";
    let remaining = source;
    const parts: string[] = [];
    while (remaining) {
      const count = partBoundary(remaining, 12, codec);
      const part = remaining.slice(0, count);
      parts.push(part);
      expect(codec.length(codec.render(part, false))).toBeLessThanOrEqual(12);
      expect(codec.length(codec.render(part, true))).toBeLessThanOrEqual(12);
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part)).toBe(false);
      remaining = remaining.slice(count);
    }
    expect(parts.join("")).toBe(source);
  });
});
