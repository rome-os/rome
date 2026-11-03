import { describe, expect, it } from "@rstest/core";
import { isLoopbackAddress } from "./trusted-loopback.js";

describe("isLoopbackAddress", () => {
  it("accepts the loopback range in every spelling Node reports", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.8.8")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects non-loopback and malformed addresses", () => {
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("172.18.0.5")).toBe(false);
    expect(isLoopbackAddress("::ffff:172.18.0.5")).toBe(false);
    expect(isLoopbackAddress("1270.0.0.1")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
