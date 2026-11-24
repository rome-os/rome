import { describe, expect, it } from "@rstest/core";
import { MailboxClaims } from "./mailbox-claims.js";

describe("connections claiming the instance's relay mailbox", () => {
  it("reports only the first claim and the last release", () => {
    let changes = 0;
    const claims = new MailboxClaims(() => changes++);
    const first = claims.claim();
    const second = claims.claim();
    expect([claims.any, changes]).toEqual([true, 1]);
    first();
    first();
    expect([claims.any, changes]).toEqual([true, 1]);
    second();
    expect([claims.any, changes]).toEqual([false, 2]);
  });
});
