import { describe, expect, it } from "@rstest/core";
import { AppManifestSchema } from "./manifest.js";

const base = { formatVersion: 1, id: "translate", version: "0.0.1", description: "for agents" };
const withTarget = (shareTarget: unknown) => ({
  ...base,
  web: { manifest: "web/manifest.json", shareTarget },
});

describe("AppManifestSchema web.shareTarget", () => {
  it("accepts a share target with or without an app route", () => {
    expect(AppManifestSchema.parse(withTarget({ path: "/quick" })).web?.shareTarget).toEqual({
      path: "/quick",
    });
    expect(AppManifestSchema.parse(withTarget({})).web?.shareTarget).toEqual({});
  });

  it("accepts nested routes and the root", () => {
    expect(AppManifestSchema.parse(withTarget({ path: "/" })).web?.shareTarget?.path).toBe("/");
    expect(
      AppManifestSchema.parse(withTarget({ path: "/look-up/word_1" })).web?.shareTarget,
    ).toEqual({ path: "/look-up/word_1" });
  });

  it("rejects a path that is not an app route or carries its own query", () => {
    expect(() => AppManifestSchema.parse(withTarget({ path: "quick" }))).toThrow(/app route/);
    expect(() => AppManifestSchema.parse(withTarget({ path: "/quick?x=1" }))).toThrow(/app route/);
  });

  it("rejects a path that would climb out of the app's route", () => {
    for (const path of ["/../other-app/share", "/%2e%2e/%2e%2e/settings", "/a/../../x", "//evil"]) {
      expect(() => AppManifestSchema.parse(withTarget({ path }))).toThrow(/app route/);
    }
  });

  it("accepts a panel size within the limits and rejects one outside them", () => {
    expect(
      AppManifestSchema.parse(withTarget({ path: "/quick", width: 380, height: 460 })).web
        ?.shareTarget,
    ).toEqual({ path: "/quick", width: 380, height: 460 });
    for (const size of [{ width: 100 }, { width: 2000 }, { height: 50 }, { height: 380.5 }]) {
      expect(() => AppManifestSchema.parse(withTarget(size))).toThrow();
    }
  });

  it("rejects unknown share target fields", () => {
    expect(() => AppManifestSchema.parse(withTarget({ param: "q" }))).toThrow();
  });
});
