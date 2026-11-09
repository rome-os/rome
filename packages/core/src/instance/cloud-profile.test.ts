import { describe, expect, it } from "@rstest/core";
import {
  type CloudProfile as CoreProfile,
  type CloudProfileOutcome as CoreOutcome,
  CloudProfileClient,
  readCloudProfile,
} from "./cloud-profile.js";
import type {
  CloudProfile as ActionProfile,
  CloudProfileOutcome as ActionOutcome,
} from "../../../../rome_apps/system/src/actions/get-guardian-cloud-profile/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const profileInSync: Equal<CoreProfile, ActionProfile> = true;
const outcomeInSync: Equal<CoreOutcome, ActionOutcome> = true;

const account = {
  id: "acct",
  email: "ada@example.com",
  avatarUrl: "https://example.com/a.png",
  slug: "ada",
  displayName: " Ada Lovelace ",
  createdAt: "2026-10-01T00:00:00.000Z",
  signInLinks: [{ provider: "google", login: "ada", email: "ada@example.com", displayName: "Ada" }],
  survey: {
    submittedAt: "2026-10-01T00:00:00.000Z",
    discoverySource: "x",
    discoverySourceOther: null,
    professionalBackground: "other",
    professionalBackgroundOther: "Bakery owner",
    buildGoals: ["Order tracking", " ", 3],
    buildDescription: "A pickup board",
    xHandle: "ada",
    linkedinHandle: "ada-l",
  },
  research: {
    status: "completed",
    completedAt: "2026-10-02T00:00:00.000Z",
    report: {
      identity: { status: "likely", basis: "same bakery" },
      name: "Ada Lovelace",
      headline: "Owner, Ada's Cakes",
      role: "Owner",
      company: "Ada's Cakes",
      location: "San Francisco",
      summary: "Runs a two-store bakery.",
      facts: [{ topic: "work", text: "Opened a second store", sourceUrl: "https://example.com" }],
      accounts: [{ platform: "linkedin", url: "https://linkedin.com/in/ada-l", matchedBy: "x" }],
      surveyFit: "fits",
      limitations: "none",
    },
  },
};

describe("readCloudProfile", () => {
  it("passes the whole whoami account through", () => {
    expect(readCloudProfile(account)).toEqual(account);
  });

  it("reads a missing or malformed account as an empty profile", () => {
    for (const value of [null, undefined, "x", []]) expect(readCloudProfile(value)).toEqual({});
  });
});

describe("CloudProfileClient", () => {
  it("reports an unenrolled or rejected instance as unavailable", async () => {
    for (const status of ["no_token", "revoked", "unknown", "unreachable"] as const) {
      const client = new CloudProfileClient(async () => ({ status }));
      expect(await client.get()).toEqual({ kind: "unavailable", reason: status });
    }
  });

  it("returns the profile from whoami", async () => {
    const profile = readCloudProfile(account);
    const client = new CloudProfileClient(async () => ({
      status: "ok",
      identity: { accountId: "acct", instanceId: "inst", profile },
    }));
    expect(await client.get()).toEqual({ kind: "ok", profile });
  });

  it("matches the system action's structural copy (enforced by typecheck)", () => {
    expect(profileInSync && outcomeInSync).toBe(true);
  });
});
