import { describe, expect, it } from "@rstest/core";
import { LINKABLE_KINDS } from "../../../../packages/api-types/src/account-agents.js";
import { ACCOUNT_KINDS, GUARDIAN_OWN_KINDS } from "./chat-activity.js";

describe("ACCOUNT_KINDS", () => {
  // A connection kind an agent can be linked to that Dream neither reads nor leaves
  // out on purpose would neither start a dream nor be read in one.
  it("names every connection kind an agent can be linked to, less the guardian's own", () => {
    expect([...ACCOUNT_KINDS, ...GUARDIAN_OWN_KINDS].sort()).toEqual([...LINKABLE_KINDS].sort());
  });
});
