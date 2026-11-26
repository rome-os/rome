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

  it("rejects a path that is not an app route or carries its own query", () => {
    expect(() => AppManifestSchema.parse(withTarget({ path: "quick" }))).toThrow(/app route/);
    expect(() => AppManifestSchema.parse(withTarget({ path: "/quick?x=1" }))).toThrow(/app route/);
  });

  it("rejects unknown share target fields", () => {
    expect(() => AppManifestSchema.parse(withTarget({ param: "q" }))).toThrow();
  });
});
