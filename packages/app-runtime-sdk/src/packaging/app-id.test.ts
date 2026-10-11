import { describe, expect, it } from "@rstest/core";
import { appIdToPathSegment, assertValidAppId, isValidAppId } from "./app-id.js";
import { parseAppManifest, requireManifestId } from "./manifest.js";

describe("app id grammar", () => {
  it.each([
    "inbox",
    "ask-user",
    "a",
    "app2",
    "x".repeat(64),
    "@ray/inbox",
    "@alice/2048_game",
  ])("accepts app id %j", (id) => {
    expect(isValidAppId(id)).toBe(true);
    expect(() => assertValidAppId(id)).not.toThrow();
  });

  it.each([
    ["slash-bearing id", "ray/inbox"],
    ["malformed scoped id", "@ray/inbox/extra"],
    ["ambiguous scoped id", "@ray/ray"],
    ["path traversal", "../etc"],
    ["uppercase", "Inbox"],
    ["leading digit", "2fast"],
    ["leading hyphen", "-inbox"],
    ["empty", ""],
    ["over 64 chars", "x".repeat(65)],
    ["underscore", "my_app"],
    ["reserved core namespace", "core"],
    ["reserved self reference", "self"],
  ])("rejects %s (%j)", (_label, id) => {
    expect(isValidAppId(id)).toBe(false);
    expect(() => assertValidAppId(id)).toThrow(/Invalid app id/);
  });

  it("encodes a scoped id as one path segment", () => {
    expect(appIdToPathSegment("@foo/bar")).toBe("%40foo%2Fbar");
    expect(appIdToPathSegment("inbox")).toBe("inbox");
  });
});

describe("manifest id", () => {
  it("rejects a manifest whose id is not a valid app id", () => {
    expect(() => requireManifestId({ id: "@ray/inbox/extra" }, "app.yaml")).toThrow(
      /must be an unscoped lowercase slug or a scoped App Store id/,
    );
  });

  it("accepts a manifest with a slug id", () => {
    expect(requireManifestId({ id: "inbox" }, "app.yaml")).toBe("inbox");
  });

  it("accepts a manifest with a scoped id", () => {
    expect(requireManifestId({ id: "@foo/bar" }, "app.yaml")).toBe("@foo/bar");
  });

  it("requires a SQL-safe table prefix when a scoped app declares a database", () => {
    const manifest = {
      formatVersion: 2 as const,
      id: "@foo/bar",
      version: "1.0.0",
      description: "Scoped DB app",
      db: { migrations: "db/migrations" },
    };
    expect(() => parseAppManifest(manifest, "app.yaml")).toThrow(
      /db\.tablePrefix: is required for a scoped app id/,
    );
    expect(
      parseAppManifest({ ...manifest, db: { ...manifest.db, tablePrefix: "foo_bar" } }, "app.yaml")
        .id,
    ).toBe("@foo/bar");
  });
});
