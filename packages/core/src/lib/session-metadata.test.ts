import { describe, expect, it } from "@rstest/core";
import { parseSessionMetadata, sessionMetadataSchema } from "./session-metadata.js";

describe("session metadata", () => {
  it("validates creation metadata and rejects unknown keys and invalid values", () => {
    expect(
      sessionMetadataSchema.parse({ isolated: true, purpose: " benchmark ", appId: "navi-bench" }),
    ).toEqual({ isolated: true, purpose: "benchmark", appId: "navi-bench" });
    for (const value of [
      null,
      [],
      { isolated: 1 },
      { isolated: "true" },
      { purpose: " " },
      { purpose: "x".repeat(201) },
      { appId: "app:action" },
      { appId: "bad_name" },
      { unknown: true },
    ]) {
      expect(sessionMetadataSchema.safeParse(value).success).toBe(false);
    }
    expect(sessionMetadataSchema.parse({})).toEqual({});
    expect(sessionMetadataSchema.parse({ appId: "@alice/navi-bench" }).appId).toBe(
      "@alice/navi-bench",
    );
  });

  it("tolerates legacy and malformed JSON without coercing an isolation flag", () => {
    for (const value of [
      undefined,
      null,
      "{",
      "null",
      "[]",
      "{}",
      '{"isolated":1}',
      '{"isolated":"true"}',
    ]) {
      expect(parseSessionMetadata(value).isolated).not.toBe(true);
    }
    expect(parseSessionMetadata('{"isolated":true,"unknown":1}')).toEqual({ isolated: true });
  });
});
