import { describe, expect, it } from "@rstest/core";
import { PhoneWatching } from "./phone-watching.js";

describe("PhoneWatching", () => {
  it("counts each phone on a chat until each lets go, once", () => {
    const watching = new PhoneWatching();
    const first = watching.watch("guardian", "c");
    const second = watching.watch("guardian", "c");
    first();
    first();
    expect(watching.isWatching("guardian", "c")).toBe(true);
    second();
    expect(watching.isWatching("guardian", "c")).toBe(false);
    expect(watching.isWatching("guardian", "other")).toBe(false);
  });

  it("counts a phone only for the person signed in on it", () => {
    const watching = new PhoneWatching();
    watching.watch("visitor:acct-1", "c");
    expect(watching.isWatching("visitor:acct-1", "c")).toBe(true);
    expect(watching.isWatching("guardian", "c")).toBe(false);
    expect(watching.isWatching("visitor:acct-2", "c")).toBe(false);
  });
});
