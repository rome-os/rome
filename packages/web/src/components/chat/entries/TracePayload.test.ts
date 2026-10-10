import { describe, expect, it } from "@rstest/core";
import { toTraceImage } from "./TracePayload";

describe("toTraceImage", () => {
  it("returns null for non-image values", () => {
    expect(toTraceImage(null)).toBeNull();
    expect(toTraceImage("hello")).toBeNull();
    expect(toTraceImage({ type: "text" })).toBeNull();
  });

  it("decodes the top-level base64 data form into a data: URL", () => {
    const result = toTraceImage({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(result).toEqual({ src: "data:image/png;base64,AAAA", rest: {} });
  });

  it("keeps generated-image metadata next to an inline image", () => {
    const result = toTraceImage({
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
      saved_path: "/tmp/apple.png",
      revised_prompt: "A realistic apple",
    });
    expect(result).toEqual({
      src: "data:image/png;base64,AAAA",
      rest: {
        saved_path: "/tmp/apple.png",
        revised_prompt: "A realistic apple",
      },
    });
  });

  it("decodes the source.base64 form", () => {
    const result = toTraceImage({
      type: "image",
      source: { type: "base64", data: "AAAA", media_type: "image/jpeg" },
    });
    expect(result).toEqual({ src: "data:image/jpeg;base64,AAAA", rest: {} });
  });

  it("falls back to image/png when the declared MIME isn't an image/* type", () => {
    // A malicious server could otherwise sneak `text/html;...` past us.
    const result = toTraceImage({ type: "image", data: "AAAA", mimeType: "text/html" });
    expect(result).toEqual({ src: "data:image/png;base64,AAAA", rest: {} });
  });

  it("accepts https URLs from external hosts", () => {
    const result = toTraceImage({
      type: "image",
      source: { type: "url", url: "https://example.com/screenshot.png" },
    });
    expect(result).toEqual({ src: "https://example.com/screenshot.png", rest: {} });
  });

  it("rejects http:// URLs (SSRF guard — only https reaches the browser)", () => {
    expect(
      toTraceImage({
        type: "image",
        source: { type: "url", url: "http://example.com/x.png" },
      }),
    ).toBeNull();
  });

  it("rejects loopback + private network hosts even over https", () => {
    const privateHosts = [
      "https://localhost/x.png",
      "https://127.0.0.1/x.png",
      "https://0.0.0.0/x.png",
      "https://10.0.0.1/x.png",
      "https://192.168.1.5/x.png",
      "https://172.16.0.1/x.png",
      "https://172.31.255.254/x.png",
      "https://169.254.169.254/latest/meta-data/",
      "https://machine.local/x.png",
    ];
    for (const url of privateHosts) {
      expect(toTraceImage({ type: "image", source: { type: "url", url } })).toBeNull();
    }
  });

  it("rejects unparseable URLs", () => {
    expect(toTraceImage({ type: "image", source: { type: "url", url: "not a url" } })).toBeNull();
  });

  it("rejects javascript: and file: schemes", () => {
    expect(
      toTraceImage({
        type: "image",
        source: { type: "url", url: "javascript:alert(1)" },
      }),
    ).toBeNull();
    expect(
      toTraceImage({
        type: "image",
        source: { type: "url", url: "file:///etc/passwd" },
      }),
    ).toBeNull();
  });
});
