import { describe, expect, it } from "@rstest/core";
import { brokenGrant, givenGrant, refuseDifferentAccount, renewedGrant } from "./connection.js";
import { DifferentAccountError } from "./errors.js";
import { NO_GRANT } from "./grant.js";
import type { ConnectionDescriptor } from "./types.js";

const descriptor = {
  connectionKind: "telegram",
  accountIdOf: (profile: Record<string, unknown>) => String(profile.id),
} as unknown as ConnectionDescriptor;
const now = new Date("2026-10-26T00:00:00Z");
const credential = { material: { token: "t" }, expiresAt: "never" as const };
const account = { platform: "telegram", accountId: "100" };
const grantEpoch = "grant-1";

describe("connection rules", () => {
  it("refuses a fix that reaches another account", () => {
    const held = givenGrant(now, credential, grantEpoch, { id: 100 }, account);

    expect(() =>
      refuseDifferentAccount(descriptor, "c1", held, { platform: "telegram", accountId: "200" }),
    ).toThrow(DifferentAccountError);
    expect(() => refuseDifferentAccount(descriptor, "c1", held, account)).not.toThrow();
  });

  it("refuses by the profile's account when the held grant stored none", () => {
    const held = givenGrant(now, credential, grantEpoch, { id: 100 });

    expect(() =>
      refuseDifferentAccount(descriptor, "c1", held, { platform: "telegram", accountId: "200" }),
    ).toThrow(DifferentAccountError);
  });

  it("never refuses a fix of a revoked grant", () => {
    expect(() => refuseDifferentAccount(descriptor, "c1", NO_GRANT, account)).not.toThrow();
  });

  it("breaks a grant in place, keeping its credential and account", () => {
    const held = givenGrant(now, credential, grantEpoch, { id: 100 }, account);
    const broken = brokenGrant(held, "rejected", now);

    expect(broken).toMatchObject({
      state: "degraded",
      degraded: { at: now, reason: "rejected" },
      credential: held.credential,
      account,
    });
  });

  it("clears a break when the grant is renewed", () => {
    const broken = brokenGrant(givenGrant(now, credential, grantEpoch), "rejected", now);
    const renewed = renewedGrant(broken, { material: { token: "u" }, expiresAt: "never" }, now);

    expect(renewed.state).toBe("authorized");
    expect(renewed.degraded).toBeUndefined();
    expect(renewed.lastRenewedAt).toBe(now);
  });
});
