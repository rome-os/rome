import { describe, expect, it } from "@rstest/core";
import { LINKABLE_SERVICES } from "../../../../packages/api-types/src/account-agents.js";
import { ACCOUNT_SERVICES, GUARDIAN_OWN_SERVICES } from "./chat-activity.js";

describe("ACCOUNT_SERVICES", () => {
  // A service an agent can be linked to that Dream neither reads nor leaves
  // out on purpose would neither start a dream nor be read in one.
  it("names every service an agent can be linked to, less the guardian's own", () => {
    expect([...ACCOUNT_SERVICES, ...GUARDIAN_OWN_SERVICES].sort()).toEqual(
      [...LINKABLE_SERVICES].sort(),
    );
  });
});
