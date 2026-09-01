import { describe, expect, it, rs } from "@rstest/core";

rs.mock("electron", () => ({
  app: undefined,
  shell: {
    openExternal: rs.fn(),
    openPath: rs.fn(),
  },
}));

rs.mock("../logger", () => ({
  createLogger: () => ({
    error: rs.fn(),
    info: rs.fn(),
  }),
}));

import { selectProvider } from "./manager";
import { resolveRuntimePaths } from "./config";

describe("selectProvider", () => {
  const paths = resolveRuntimePaths();

  it("returns the Lima provider on macOS 13+ arm64", () => {
    const provider = selectProvider(paths, {
      platform: "darwin",
      arch: "arm64",
      release: "22.0.0",
    });
    expect(provider.kind).toBe("lima");
  });

  it("throws below the macOS floor", () => {
    expect(() =>
      selectProvider(paths, { platform: "darwin", arch: "arm64", release: "21.6.0" }),
    ).toThrow(/macOS 13/);
  });

  it("throws on Intel Macs", () => {
    expect(() =>
      selectProvider(paths, { platform: "darwin", arch: "x64", release: "25.0.0" }),
    ).toThrow(/macOS 13/);
  });

  it("throws on non-darwin hosts", () => {
    expect(() =>
      selectProvider(paths, { platform: "linux", arch: "arm64", release: "6.5.0" }),
    ).toThrow(/macOS 13/);
  });
});
