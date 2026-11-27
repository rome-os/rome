import { describe, expect, it } from "@rstest/core";
import { madeForSomeoneElse } from "./owner-actor.js";

describe("madeForSomeoneElse", () => {
  it("reads a member's send as someone else's, and the guardian's only outside their own chat", () => {
    expect(madeForSomeoneElse("visitor", "visitor:a")).toBe(true);
    expect(madeForSomeoneElse("visitor", "guardian")).toBe(true);
    expect(madeForSomeoneElse("guardian", "guardian")).toBe(false);
    expect(madeForSomeoneElse("guardian", "visitor:a")).toBe(true);
    expect(madeForSomeoneElse(undefined, "visitor:a")).toBe(false);
  });
});
