import { describe, expect, it } from "@rstest/core";
import { drainsWithClaims, MailboxClaims } from "./mailbox-claims.js";

const SETTING = {
  drainUrl: "wss://relay.test/c/mbx",
  drainKey: "k",
  depositUrl: "https://relay.test/h/mbx",
};
const APP_DRAIN = {
  connectUrl: "wss://relay.test/c/mbx",
  drainKey: "k",
  targetAppId: "connector",
  targetPath: ["webhook"],
};

describe("draining the instance's own relay mailbox", () => {
  it("drains nothing with no app to take its webhooks and no connection claiming it", () => {
    expect(drainsWithClaims({ resolved: [], setting: SETTING, claimed: false })).toEqual([]);
  });

  it("drains to the app that takes its webhooks, as before", () => {
    expect(drainsWithClaims({ resolved: [APP_DRAIN], setting: SETTING, claimed: true })).toEqual([
      APP_DRAIN,
    ]);
  });

  it("drains the mailbox alone while a connection claims it and no app takes webhooks", () => {
    expect(drainsWithClaims({ resolved: [], setting: SETTING, claimed: true })).toEqual([
      { connectUrl: SETTING.drainUrl, drainKey: "k", targetAppId: "", targetPath: [] },
    ]);
    expect(drainsWithClaims({ resolved: [], setting: null, claimed: true })).toEqual([]);
  });

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
