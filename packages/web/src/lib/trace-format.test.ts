import { describe, expect, it } from "@rstest/core";
import { formatTracePrimitive, normalizeTracePayload } from "@/lib/trace-format";

describe("normalizeTracePayload", () => {
  it("keeps object values as-is", () => {
    expect(normalizeTracePayload({ ok: true, nested: { id: 1 } })).toEqual({
      ok: true,
      nested: { id: 1 },
    });
  });

  it("parses JSON object strings into objects", () => {
    expect(normalizeTracePayload('{"ok":true,"items":[1,2]}')).toEqual({
      ok: true,
      items: [1, 2],
    });
  });

  it("leaves plain strings unchanged", () => {
    expect(normalizeTracePayload("plain text output")).toBe("plain text output");
  });

  it("leaves JSON primitive strings unchanged", () => {
    expect(normalizeTracePayload("true")).toBe("true");
    expect(normalizeTracePayload("123")).toBe("123");
    expect(normalizeTracePayload('"hello"')).toBe('"hello"');
  });
});

describe("formatTracePrimitive", () => {
  it("formats primitive values for inline display", () => {
    expect(formatTracePrimitive("hello")).toBe("hello");
    expect(formatTracePrimitive(123)).toBe("123");
    expect(formatTracePrimitive(false)).toBe("false");
    expect(formatTracePrimitive(null)).toBe("null");
    expect(formatTracePrimitive(undefined)).toBe("(no output)");
  });
});
