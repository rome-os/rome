import { describe, it, expect } from "@rstest/core";
import { hashArgs } from "./replay.js";

describe("hashArgs", () => {
  it("returns a stable base64url hash for the same args", () => {
    const args = { foo: "bar", num: 42 };
    const h1 = hashArgs(args);
    const h2 = hashArgs(args);
    expect(h1).toBe(h2);
    expect(typeof h1).toBe("string");
    expect(h1.length).toBeGreaterThan(0);
  });

  it("returns different hashes for different args", () => {
    const h1 = hashArgs({ a: 1 });
    const h2 = hashArgs({ a: 2 });
    expect(h1).not.toBe(h2);
  });

  it("handles empty args object", () => {
    const h = hashArgs({});
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
    // SHA-256 base64url is always 43 characters
    expect(h).toHaveLength(43);
  });

  it("produces the same hash regardless of key order", () => {
    const h1 = hashArgs({ a: 1, b: 2 });
    const h2 = hashArgs({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it("produces the same hash for nested objects with different key order", () => {
    const h1 = hashArgs({ outer: { x: 1, y: 2 }, z: 3 });
    const h2 = hashArgs({ z: 3, outer: { y: 2, x: 1 } });
    expect(h1).toBe(h2);
  });
});
