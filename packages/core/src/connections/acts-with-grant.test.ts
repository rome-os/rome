import { describe, expect, it } from "@rstest/core";
import { actStatusOf } from "./acts-with-grant.js";
import type { CapabilityStatus, ConnectionDescriptor } from "./types.js";

const UNSUPPORTED: CapabilityStatus = { state: "unsupported" };

function kind(fields: Partial<ConnectionDescriptor>): ConnectionDescriptor {
  return { capabilities: {}, ...fields } as ConnectionDescriptor;
}

describe("actStatusOf", () => {
  it("unlocks act for a kind that acts with its grant once every grant is authorized", () => {
    const descriptor = kind({ actsWithGrant: true });
    expect(actStatusOf(descriptor, UNSUPPORTED, { bot: "authorized" })).toEqual({
      state: "unlocked",
    });
    expect(
      actStatusOf(descriptor, UNSUPPORTED, { bot: "authorized", user: "unauthorized" }),
    ).toEqual({ state: "needs-auth", missingGrants: ["user"] });
  });

  it("leaves act as it stands for a kind with an actor or without the flag", () => {
    const needs: CapabilityStatus = { state: "needs-auth", missingGrants: ["bot"] };
    const withActor = kind({
      actsWithGrant: true,
      capabilities: { actor: {} } as ConnectionDescriptor["capabilities"],
    });
    expect(actStatusOf(withActor, needs, { bot: "authorized" })).toBe(needs);
    expect(actStatusOf(kind({}), UNSUPPORTED, { bot: "authorized" })).toBe(UNSUPPORTED);
    expect(actStatusOf(undefined, UNSUPPORTED, {})).toBe(UNSUPPORTED);
  });
});
