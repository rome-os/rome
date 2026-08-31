import { describe, expect, it } from "@rstest/core";
import { shouldSubmitOnEnter } from "./keyboard-submit";

describe("shouldSubmitOnEnter", () => {
  it("submits on plain Enter", () => {
    expect(shouldSubmitOnEnter({ key: "Enter" })).toBe(true);
  });

  it("does not submit on Shift+Enter", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(false);
  });

  it("treats keyCode 229 as IME composition for browser compatibility", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBe(false);
  });

  // Touch-first devices pass enterSends: false — Enter inserts a newline
  // there and sending happens via the send button.
  it("never submits when enterSends is false", () => {
    expect(shouldSubmitOnEnter({ key: "Enter" }, { enterSends: false })).toBe(false);
  });

  it("keeps the desktop behavior when enterSends is true or omitted", () => {
    expect(shouldSubmitOnEnter({ key: "Enter" }, { enterSends: true })).toBe(true);
    expect(shouldSubmitOnEnter({ key: "Enter" }, {})).toBe(true);
  });
});
