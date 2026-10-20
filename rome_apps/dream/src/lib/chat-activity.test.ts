import { describe, expect, it } from "@rstest/core";
import { LINKABLE_SERVICES } from "../../../../packages/api-types/src/account-agents.js";
import { ACCOUNT_SERVICES } from "./chat-activity.js";

describe("ACCOUNT_SERVICES", () => {
  // A service an agent can be linked to and Dream does not read would neither
  // start a dream nor be read in one.
  it("names exactly the services an agent can be linked to", () => {
    expect([...ACCOUNT_SERVICES].sort()).toEqual([...LINKABLE_SERVICES].sort());
  });
});
