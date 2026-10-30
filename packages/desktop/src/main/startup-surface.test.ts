import { describe, expect, it } from "@rstest/core";
import {
  chooseStartupSurface,
  shouldAutoOpenDashboard,
  shouldReturnToDashboard,
} from "./startup-surface";

const DASHBOARD = "https://ray.romeos.cc";
const ONBOARDING =
  "file:///Applications/Rome.app/Contents/Resources/app.asar/src/renderer/onboarding.html";

// There is no Rome on this computer to wait for: the window shows the welcome
// page until the hosted Rome is ready, then the Rome itself.
describe("chooseStartupSurface", () => {
  it("shows the welcome page while the Rome is not ready", () => {
    expect(chooseStartupSurface(DASHBOARD, false)).toEqual({ kind: "onboarding" });
  });

  it("opens the Rome once it is ready", () => {
    expect(chooseStartupSurface(DASHBOARD, true)).toEqual({ kind: "dashboard", url: DASHBOARD });
  });
});

describe("shouldAutoOpenDashboard", () => {
  it("leaves the welcome page and a blank window for the Rome", () => {
    expect(shouldAutoOpenDashboard(ONBOARDING, ONBOARDING, DASHBOARD)).toBe(true);
    expect(shouldAutoOpenDashboard("", ONBOARDING, DASHBOARD)).toBe(true);
  });

  // A provider's sign-in page is mid-flow; yanking it away would strand the user.
  it("leaves any other page alone", () => {
    expect(shouldAutoOpenDashboard("https://github.com/login", ONBOARDING, DASHBOARD)).toBe(false);
  });
});

describe("shouldReturnToDashboard", () => {
  // The case the menu item exists for: a provider's OAuth page owns the whole
  // frameless window and offers nothing to click to get out.
  it("navigates away from a provider's sign-in page", () => {
    expect(shouldReturnToDashboard("https://github.com/login", DASHBOARD)).toBe(true);
    expect(shouldReturnToDashboard("https://accounts.google.com/o/oauth2/auth", DASHBOARD)).toBe(
      true,
    );
  });

  it("navigates away from onboarding once the runtime is up", () => {
    expect(
      shouldReturnToDashboard("file:///Applications/Rome.app/onboarding.html", DASHBOARD),
    ).toBe(true);
  });

  // Reloading would throw away a half-written message.
  it("stays put anywhere under the dashboard", () => {
    expect(shouldReturnToDashboard(DASHBOARD, DASHBOARD)).toBe(false);
    expect(shouldReturnToDashboard(`${DASHBOARD}/`, DASHBOARD)).toBe(false);
    expect(shouldReturnToDashboard(`${DASHBOARD}/settings/connections`, DASHBOARD)).toBe(false);
  });

  // Another instance is somebody else's Rome.
  it("navigates away from another origin", () => {
    expect(shouldReturnToDashboard("https://work.romeos.cc/", DASHBOARD)).toBe(true);
  });

  // The dashboard sits in the user-info, so the host is evil.example. A prefix
  // match reads this as home and strands the window on it.
  it("navigates away from a URL wearing the dashboard as credentials", () => {
    expect(shouldReturnToDashboard(`${DASHBOARD}@evil.example/`, DASHBOARD)).toBe(true);
  });

  it("navigates when the window has no URL yet", () => {
    expect(shouldReturnToDashboard("", DASHBOARD)).toBe(true);
    expect(shouldReturnToDashboard("about:blank", DASHBOARD)).toBe(true);
  });
});
