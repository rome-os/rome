import { describe, expect, it } from "@rstest/core";
import { appApiAppId, appApiPath, dashboardAppId, isPublicPath } from "./ways-in.js";

describe("appApiPath", () => {
  it.each([
    ["/api/app-api/notes/a/b?c=1", { appId: "notes", subPath: "/a/b" }],
    ["/api/app-api/notes", { appId: "notes", subPath: "/" }],
    ["/api/app-api/notes/", { appId: "notes", subPath: "/" }],
    // A path the app router would refuse is still that app's.
    ["/api/app-api/notes/..%2f", { appId: "notes", subPath: null }],
    ["/api/app-api/notes/%zz", { appId: "notes", subPath: null }],
    ["/api/app-api/%zz/a", null],
    ["/api/app-api", null],
    ["/api/apps/notes/a", null],
  ])("%s", (path, expected) => {
    expect(appApiPath(path)).toEqual(expected);
    expect(appApiAppId(path)).toBe(expected?.appId ?? null);
  });
});

describe("dashboardAppId", () => {
  it.each([
    ["/api/apps/notes/api/list", "notes"],
    ["/api/apps/notes/publish", null],
    ["/api/apps/notes/publish/", null],
    ["/api/apps/notes", null],
    ["/api/apps/%zz/api", null],
    ["/api/app-api/notes/list", null],
  ])("%s", (path, expected) => {
    expect(dashboardAppId(path)).toBe(expected);
  });
});

describe("isPublicPath", () => {
  it.each([
    ["/dashboard", true],
    ["/api/health", true],
    ["/api/health/live?x=1", true],
    ["/api/setups/return", true],
    ["/api/setups/return/more", false],
    ["/api/healthy", false],
    ["/api/settings", false],
  ])("%s", (path, expected) => {
    expect(isPublicPath(path)).toBe(expected);
  });
});
