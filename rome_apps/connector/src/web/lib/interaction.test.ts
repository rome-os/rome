import { describe, expect, it } from "@rstest/core";
import { wasDismissed } from "./interaction.js";

// Regression for the dismissed-card bug: a dismissed connect/login card
// re-mounts as resolved, and was being rendered as a successful connection
// because `resolved` alone was treated as success. `wasDismissed` is the
// predicate every card now gates its success view on.

describe("wasDismissed", () => {
  it("is true for a dismiss result", () => {
    expect(wasDismissed({ dismissed: true })).toBe(true);
  });

  it("is false for a real connect result", () => {
    expect(wasDismissed({ toolkit: "twitter", status: "connected" })).toBe(false);
  });

  it("is false for a real login result", () => {
    expect(wasDismissed({ status: "signed_in", nextStep: "…" })).toBe(false);
  });

  it("is false when the card has not resolved yet", () => {
    expect(wasDismissed(undefined)).toBe(false);
  });
});
