import { describe, expect, it } from "@rstest/core";
import { decodeAppIdPathSegment } from "./route-path.js";

describe("decodeAppIdPathSegment", () => {
  it("decodes a complete scoped app id from one route segment", () => {
    expect(decodeAppIdPathSegment("%40foo%2Fbar")).toBe("@foo/bar");
  });

  it("rejects a slash that is not a valid scoped app id", () => {
    expect(() => decodeAppIdPathSegment("foo%2Fbar")).toThrow(/Invalid app id route segment/);
  });
});
