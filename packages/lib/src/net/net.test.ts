import { describe, expect, it } from "@rstest/core";
import { isLoopbackHostname, isRomeosDevHostname } from "./index";

describe("isLoopbackHostname", () => {
  it("accepts the loopback literals", () => {
    for (const h of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });

  it("accepts any .localhost name (RFC 6761)", () => {
    expect(isLoopbackHostname("foo.localhost")).toBe(true);
    expect(isLoopbackHostname("a.b.rome.localhost")).toBe(true);
  });

  it("rejects real hosts and look-alikes", () => {
    for (const h of ["example.com", "romeos.cc", "localhost.evil.com", "127.0.0.1.evil.com", ""]) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});

// HACK(zhangfan): romeos.dev is a domain owned for dev Rome instances, fronted by
// Cloudflare Access. Temporary — the callback gates treat these hosts as trusted.
describe("isRomeosDevHostname", () => {
  it("accepts the apex and any subdomain (case-insensitive)", () => {
    for (const h of ["romeos.dev", "dev.romeos.dev", "a.b.romeos.dev", "Dev.Romeos.Dev"]) {
      expect(isRomeosDevHostname(h)).toBe(true);
    }
  });

  it("rejects look-alikes and unrelated hosts", () => {
    for (const h of ["evilromeos.dev", "romeos.dev.evil.com", "romeos.cc", "notromeos.dev", ""]) {
      expect(isRomeosDevHostname(h)).toBe(false);
    }
  });
});
