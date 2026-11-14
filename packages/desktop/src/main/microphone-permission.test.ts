import { describe, expect, it } from "@rstest/core";
import { allowsMedia } from "./microphone-permission";

const DASHBOARD = "https://rome.example.com/chat";
const ask = (overrides: Partial<Parameters<typeof allowsMedia>[0]> = {}) =>
  allowsMedia(
    {
      url: "https://rome.example.com/chat/abc",
      isMainFrame: true,
      mediaTypes: ["audio"],
      ...overrides,
    },
    DASHBOARD,
  );

describe("allowsMedia", () => {
  it("gives the microphone to the Rome this launch opened", () => {
    expect(ask()).toBe(true);
  });

  it("refuses another origin, such as a sign-in page", () => {
    expect(ask({ url: "https://github.com/login" })).toBe(false);
    expect(ask({ url: "https://rome.example.com:8443/chat" })).toBe(false);
  });

  it("refuses a frame inside the dashboard", () => {
    expect(ask({ isMainFrame: false })).toBe(false);
  });

  it("refuses the camera and screen capture", () => {
    expect(ask({ mediaTypes: ["video"] })).toBe(false);
    expect(ask({ mediaTypes: ["audio", "video"] })).toBe(false);
    expect(ask({ mediaTypes: [] })).toBe(false);
  });

  it("refuses everything before a dashboard is known", () => {
    expect(
      allowsMedia({ url: "file:///onboarding.html", isMainFrame: true, mediaTypes: ["audio"] }, ""),
    ).toBe(false);
  });
});
