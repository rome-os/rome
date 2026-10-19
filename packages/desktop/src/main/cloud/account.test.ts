import { describe, expect, it, rs } from "@rstest/core";

const pending: Array<(value: { accessToken: string; deviceSessionId: string }) => void> = [];
rs.mock("./sign-in", () => ({
  // Each sign-in waits until the test lets Rome Cloud answer it.
  signInToRomeCloud: () =>
    new Promise((resolve) => {
      pending.push(resolve);
    }),
}));
rs.mock("../logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import type { SecureKeyValueStore } from "@rome-os/libs/native-auth";
import { CloudAccount } from "./account";

function account() {
  const values = new Map<string, string>();
  const store: SecureKeyValueStore = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    deleteItem: async (key) => {
      values.delete(key);
    },
  };
  const subject = new CloudAccount({
    cloudOrigin: "https://romeos.cc",
    store,
    cookies: { install: async () => {}, clear: async () => {} },
    fetchImpl: fetch,
    openBrowser: async () => {},
    device: { name: "Mac", platform: "macos", appVersion: "0.1.8", osVersion: "25.6.0" },
  });
  return Object.assign(subject, { stored: () => [...values.values()].join("") });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("CloudAccount.signIn", () => {
  it("does not save a credential that arrives after cancel", async () => {
    pending.length = 0;
    const subject = account();
    const signingIn = subject.signIn();
    await flush();
    subject.cancelSignIn();
    pending[0]!({ accessToken: "romemob_late", deviceSessionId: "s1" });
    await expect(signingIn).rejects.toThrow(/cancelled/);
    expect(await subject.isSignedIn()).toBe(false);
  });

  it("keeps the newer sign-in when the older one answers last", async () => {
    pending.length = 0;
    const subject = account();
    const older = subject.signIn();
    await flush();
    const newer = subject.signIn();
    await flush();
    pending[1]!({ accessToken: "romemob_newer", deviceSessionId: "s2" });
    await newer;
    pending[0]!({ accessToken: "romemob_older", deviceSessionId: "s1" });
    await expect(older).rejects.toThrow(/cancelled/);
    expect(subject.stored()).toContain("romemob_newer");
    expect(subject.stored()).not.toContain("romemob_older");
  });
});
