import { afterEach, describe, expect, it, rs } from "@rstest/core";

import { getDesktopBuildDefine } from "./shared-env.mjs";

describe("getDesktopBuildDefine", () => {
  // stubEnv restores whatever the developer had, and unstubs even when an
  // assertion throws. Deleting the key instead would fail for anyone who has
  // ROME_RUNTIME_IMAGE exported — which is exactly what someone wiring the
  // release build does.
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  it("bakes null when the build is not cut from a release tag", () => {
    // The resolver falls through to the moving tag on null, which is what keeps
    // a local build following whatever was published last.
    rs.stubEnv("ROME_RUNTIME_IMAGE", "");
    expect(getDesktopBuildDefine().__ROME_RUNTIME_IMAGE__).toBe("null");
  });

  it("bakes the image a tagged build was given", () => {
    rs.stubEnv("ROME_RUNTIME_IMAGE", "yunfanye/rome:1.2.3");
    expect(getDesktopBuildDefine().__ROME_RUNTIME_IMAGE__).toBe('"yunfanye/rome:1.2.3"');
  });

  it("treats a blank value as absent rather than pinning to an empty tag", () => {
    // A workflow that computes the reference and comes up empty would otherwise
    // bake "", and every install would fail to pull.
    rs.stubEnv("ROME_RUNTIME_IMAGE", "   ");
    expect(getDesktopBuildDefine().__ROME_RUNTIME_IMAGE__).toBe("null");
  });
});
