import { describe, expect, it } from "@rstest/core";
import { shouldReturnToDashboard } from "./startup-surface";

const DASHBOARD = "http://127.0.0.1:47823";

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

  // A different local port is somebody else's server, not Rome's.
  it("navigates away from another loopback port", () => {
    expect(shouldReturnToDashboard("http://127.0.0.1:3000/", DASHBOARD)).toBe(true);
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
