import { describe, expect, it } from "@rstest/core";
import { CsrfStore, randomToken } from "./csrf.js";

describe("CsrfStore", () => {
  it("returns the stored provider and origin exactly once", () => {
    const store = new CsrfStore();
    store.put("token1", "gmail", "dashboard");
    expect(store.consume("token1")).toEqual({ provider: "gmail", origin: "dashboard" });
    expect(store.consume("token1")).toBeNull();
  });

  it("round-trips the webchat origin so the callback can land the chat tab", () => {
    const store = new CsrfStore();
    store.put("token-wc", "slack", "webchat");
    expect(store.consume("token-wc")).toEqual({ provider: "slack", origin: "webchat" });
  });

  it("rejects unknown tokens", () => {
    const store = new CsrfStore();
    expect(store.consume("ghost")).toBeNull();
  });

  it("expires tokens past the 30-minute TTL", () => {
    const store = new CsrfStore();
    const base = 1_000_000_000_000;
    store.put("token2", "slack", "dashboard", base);
    const justInside = base + 29 * 60 * 1000;
    expect(store.consume("token2", justInside)).toEqual({ provider: "slack", origin: "dashboard" });

    store.put("token3", "slack", "dashboard", base);
    const past = base + 31 * 60 * 1000;
    expect(store.consume("token3", past)).toBeNull();
  });
});

describe("randomToken", () => {
  it("produces hex strings of 48 chars (24 bytes)", () => {
    const t = randomToken();
    expect(t).toMatch(/^[0-9a-f]{48}$/);
  });

  it("produces distinct values on repeated calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(randomToken());
    expect(seen.size).toBeGreaterThan(15);
  });
});
