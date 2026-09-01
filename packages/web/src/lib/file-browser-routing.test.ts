import { describe, expect, it } from "@rstest/core";
import {
  getFileBrowserDirectoryAncestors,
  getFileBrowserRouteLogicalPath,
  getFileBrowserUrlPath,
  shouldSyncRootPanelTriggerUrl,
} from "./file-browser-routing";

describe("file browser routing", () => {
  it("maps selected logical paths to tab-relative URLs", () => {
    expect(getFileBrowserUrlPath("projects", "projects/app/src/index.ts")).toBe(
      "/projects/app/src/index.ts",
    );
    expect(getFileBrowserUrlPath("memory", "memory/Research Notes.md")).toBe(
      "/memory/Research%20Notes.md",
    );
    expect(getFileBrowserUrlPath("projects", null)).toBe("/projects");
  });

  it("maps route splats back to logical paths", () => {
    expect(getFileBrowserRouteLogicalPath("projects", "app/src/index.ts")).toBe(
      "projects/app/src/index.ts",
    );
    expect(getFileBrowserRouteLogicalPath("memory", "Research%20Notes.md")).toBe(
      "memory/Research Notes.md",
    );
    expect(getFileBrowserRouteLogicalPath("memory", undefined)).toBeNull();
  });

  it("rejects unsafe route segments", () => {
    expect(getFileBrowserRouteLogicalPath("projects", "../secret.txt")).toBeNull();
    expect(getFileBrowserRouteLogicalPath("projects", "app//secret.txt")).toBeNull();
    expect(getFileBrowserRouteLogicalPath("projects", "app\\secret.txt")).toBeNull();
    expect(getFileBrowserRouteLogicalPath("projects", "app%2Fsecret.txt")).toBeNull();
  });

  it("returns directory ancestors for tree expansion", () => {
    expect(getFileBrowserDirectoryAncestors("projects/app/src/index.ts", "projects")).toEqual([
      "projects/app",
      "projects/app/src",
    ]);
    expect(getFileBrowserDirectoryAncestors("memory/IDENTITY.md", "memory")).toEqual([]);
  });

  it("syncs the root panel trigger URL only on desktop", () => {
    expect(shouldSyncRootPanelTriggerUrl(true)).toBe(true);
    expect(shouldSyncRootPanelTriggerUrl(false)).toBe(false);
  });
});
