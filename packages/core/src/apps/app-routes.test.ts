import { describe, it, expect } from "@rstest/core";
import { getAppRouteBase, getAppHref, getEmbeddedAppHref, getFullAppHref } from "./app-routes.js";

describe("app-routes", () => {
  describe("getAppRouteBase", () => {
    it("defaults to embedded", () => {
      expect(getAppRouteBase("inbox")).toBe("/apps/inbox");
    });

    it("returns the full-mode prefix when requested", () => {
      expect(getAppRouteBase("inbox", "full")).toBe("/full/apps/inbox");
    });

    it("keeps a scoped app id in one encoded route segment", () => {
      expect(getAppRouteBase("@foo/bar")).toBe("/apps/%40foo%2Fbar");
      expect(getAppRouteBase("@foo/bar", "full")).toBe("/full/apps/%40foo%2Fbar");
    });
  });

  describe("getAppHref", () => {
    it("returns the bare route base when path is empty", () => {
      expect(getAppHref("inbox")).toBe("/apps/inbox");
      expect(getAppHref("inbox", [], "full")).toBe("/full/apps/inbox");
    });

    it("joins and URL-encodes path segments", () => {
      expect(getAppHref("inbox", ["thread", "a b"])).toBe("/apps/inbox/thread/a%20b");
    });

    it("encodes special characters per segment without encoding the slash", () => {
      expect(getAppHref("inbox", ["a/b", "c?d"])).toBe("/apps/inbox/a%2Fb/c%3Fd");
    });
  });

  it("getEmbeddedAppHref and getFullAppHref are thin wrappers", () => {
    expect(getEmbeddedAppHref("inbox")).toBe("/apps/inbox");
    expect(getFullAppHref("inbox")).toBe("/full/apps/inbox");
    expect(getEmbeddedAppHref("@foo/bar")).toBe("/apps/%40foo%2Fbar");
  });
});
