import { describe, expect, it } from "@rstest/core";
import { AppManifestSchema, TAGLINE_MAX_WIDTH_UNITS } from "./manifest.js";
import { widthUnits } from "./width-units.js";

const base = { formatVersion: 1, id: "cardapp", version: "0.0.1", description: "for agents" };

describe("widthUnits", () => {
  it("counts Latin as 1 and CJK as 2", () => {
    expect(widthUnits("abc")).toBe(3);
    expect(widthUnits("你好")).toBe(4);
    expect(widthUnits("a你")).toBe(3);
    expect(widthUnits("")).toBe(0);
  });
});

describe("AppManifestSchema tagline", () => {
  it("accepts a one-line tagline up to the width budget", () => {
    expect(TAGLINE_MAX_WIDTH_UNITS).toBe(80);
    expect(AppManifestSchema.parse({ ...base, tagline: "a".repeat(80) }).tagline).toHaveLength(80);
    expect(AppManifestSchema.parse({ ...base, tagline: "你".repeat(40) }).tagline).toHaveLength(40);
    expect(AppManifestSchema.parse(base).tagline).toBeUndefined();
  });

  it("rejects taglines over the width budget, in Latin or CJK", () => {
    expect(() => AppManifestSchema.parse({ ...base, tagline: "a".repeat(81) })).toThrow(
      /80 width units/,
    );
    expect(() => AppManifestSchema.parse({ ...base, tagline: "你".repeat(41) })).toThrow(
      /80 width units/,
    );
  });

  it("rejects multi-line taglines", () => {
    expect(() => AppManifestSchema.parse({ ...base, tagline: "one\ntwo" })).toThrow(/single line/);
    expect(() => AppManifestSchema.parse({ ...base, tagline: "one\r\ntwo" })).toThrow(
      /single line/,
    );
  });
});
