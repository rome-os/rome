import { describe, expect, it } from "@rstest/core";
import { PhoneWatching } from "./phone-watching.js";

describe("PhoneWatching", () => {
  it("counts each phone on a chat until each lets go, once", () => {
    const watching = new PhoneWatching();
    const first = watching.watch("c");
    const second = watching.watch("c");
    first();
    first();
    expect(watching.isWatching("c")).toBe(true);
    second();
    expect(watching.isWatching("c")).toBe(false);
    expect(watching.isWatching("other")).toBe(false);
  });
});
