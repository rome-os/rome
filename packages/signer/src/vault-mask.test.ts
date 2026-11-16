import { describe, expect, it } from "@rstest/core";
import { createMasker, type MaskSecret } from "./vault-mask.js";

/** Feeds the chunks through one masker and returns everything it printed. */
function mask(secrets: MaskSecret[], chunks: Array<string | Buffer>): string {
  const masker = createMasker(secrets);
  const parts = chunks.map((chunk) => masker.write(Buffer.from(chunk)));
  parts.push(masker.end());
  return Buffer.concat(parts).toString("utf8");
}

const TOKEN: MaskSecret = { name: "API_TOKEN", value: "sk-abc123XYZ" };

describe("createMasker", () => {
  it("replaces a value inside a chunk", () => {
    expect(mask([TOKEN], ["key=sk-abc123XYZ done\n"])).toBe("key=[vault:API_TOKEN] done\n");
  });

  it("replaces every occurrence", () => {
    expect(mask([TOKEN], ["sk-abc123XYZ sk-abc123XYZ"])).toBe(
      "[vault:API_TOKEN] [vault:API_TOKEN]",
    );
  });

  it("replaces a value split across chunks, at every split point", () => {
    const text = "before sk-abc123XYZ after";
    for (let cut = 1; cut < text.length; cut++) {
      expect(mask([TOKEN], [text.slice(0, cut), text.slice(cut)])).toBe(
        "before [vault:API_TOKEN] after",
      );
    }
  });

  it("replaces a value fed one byte at a time", () => {
    const chunks = [..."x sk-abc123XYZ y"];
    expect(mask([TOKEN], chunks)).toBe("x [vault:API_TOKEN] y");
  });

  it("handles several names, and prefers the longest value at one position", () => {
    const secrets = [
      { name: "SHORT", value: "hunter2" },
      { name: "LONG", value: "hunter2-and-more" },
      { name: "OTHER", value: "zzz-other" },
    ];
    expect(mask(secrets, ["a hunter2-and-more b hunter2 c zzz-other"])).toBe(
      "a [vault:LONG] b [vault:SHORT] c [vault:OTHER]",
    );
  });

  it("masks a value that contains another value", () => {
    const secrets = [
      { name: "INNER", value: "abc" },
      { name: "OUTER", value: "xabcx" },
    ];
    expect(mask(secrets, ["..xabcx.."])).toBe("..[vault:OUTER]..");
  });

  it("matches repeated characters without false positives", () => {
    expect(mask([{ name: "A", value: "aaa" }], ["aa aaaa aab"])).toBe("aa [vault:A]a aab");
  });

  it("does not touch text that only resembles a value", () => {
    const text = "sk-abc123XY sk-abc123XYz sk-abc12 plain text\n";
    expect(mask([TOKEN], [text.slice(0, 10), text.slice(10)])).toBe(text);
  });

  it("flushes a held-back tail when the stream ends", () => {
    expect(mask([TOKEN], ["ends with sk-abc"])).toBe("ends with sk-abc");
    expect(mask([TOKEN], ["ends with sk-abc123XYZ"])).toBe("ends with [vault:API_TOKEN]");
  });

  it("ignores empty values", () => {
    expect(mask([{ name: "EMPTY", value: "" }], ["unchanged text"])).toBe("unchanged text");
    expect(mask([{ name: "EMPTY", value: "" }, TOKEN], ["sk-abc123XYZ"])).toBe("[vault:API_TOKEN]");
  });

  it("matches multi-byte UTF-8 values split mid-character", () => {
    const secret = { name: "ZH", value: "密码🔑✓" };
    const bytes = Buffer.from("前缀 密码🔑✓ 后缀");
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(mask([secret], [bytes.subarray(0, cut), bytes.subarray(cut)])).toBe(
        "前缀 [vault:ZH] 后缀",
      );
    }
  });

  it("passes binary output through unchanged", () => {
    const masker = createMasker([TOKEN]);
    const bytes = Buffer.from([0, 255, 128, 10, 13, 0xc3]);
    const out = Buffer.concat([masker.write(bytes), masker.end()]);
    expect(out.equals(bytes)).toBe(true);
  });

  it("passes everything through when there is nothing to mask", () => {
    expect(mask([], ["a", "b"])).toBe("ab");
  });
});
