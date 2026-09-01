import { describe, expect, it } from "@rstest/core";
import { resolveInitialSelectedFolderPath } from "./file-browser-initial-selection";

describe("resolveInitialSelectedFolderPath", () => {
  it("returns no selection when no initial folder is configured", () => {
    expect(
      resolveInitialSelectedFolderPath({
        initialSelectedFolderPath: undefined,
        isDesktopViewport: true,
        selectInitialFolderOnMobile: true,
      }),
    ).toBeNull();
  });

  it("keeps the initial folder on desktop", () => {
    expect(
      resolveInitialSelectedFolderPath({
        initialSelectedFolderPath: "projects/default",
        isDesktopViewport: true,
        selectInitialFolderOnMobile: false,
      }),
    ).toBe("projects/default");
  });

  it("keeps the initial folder on mobile when mobile selection is allowed", () => {
    expect(
      resolveInitialSelectedFolderPath({
        initialSelectedFolderPath: "projects/default",
        isDesktopViewport: false,
        selectInitialFolderOnMobile: true,
      }),
    ).toBe("projects/default");
  });

  it("skips the initial folder on mobile when mobile selection is disabled", () => {
    expect(
      resolveInitialSelectedFolderPath({
        initialSelectedFolderPath: "projects/default",
        isDesktopViewport: false,
        selectInitialFolderOnMobile: false,
      }),
    ).toBeNull();
  });
});
