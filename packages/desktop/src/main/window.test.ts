import { describe, expect, it, rs } from "@rstest/core";

rs.mock("electron", () => ({
  BrowserWindow: class {},
  session: { defaultSession: { webRequest: { onHeadersReceived: rs.fn() } } },
  shell: { openExternal: rs.fn() },
}));
rs.mock("./lifecycle", () => ({ isQuitting: () => false }));

import { contentSecurityPolicy, loadFailureAction, policyAppliesTo } from "./window";

describe("contentSecurityPolicy", () => {
  const policy = contentSecurityPolicy();

  it("lets the app's pages load only their own files", () => {
    expect(policy).toContain("default-src 'self' 'unsafe-inline';");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).toContain("frame-src 'none';");
  });

  // These pages used to share a policy with the dashboard on the private VM's
  // loopback proxy. Nothing they load comes from there any more.
  it("no longer names loopback or Rome Cloud sources", () => {
    expect(policy).not.toMatch(/127\.0\.0\.1|localhost|romeos\.cc|googletagmanager/);
  });
});

describe("policyAppliesTo", () => {
  it("covers the packaged pages", () => {
    expect(policyAppliesTo("file:///Applications/Rome.app/onboarding.html")).toBe(true);
  });

  // The Rome the window opens is a website with its own headers, and so is a
  // dev stack opened through ROME_DESKTOP_DASHBOARD_URL.
  it("leaves every Rome alone", () => {
    expect(policyAppliesTo("https://ray.romeos.cc/")).toBe(false);
    expect(policyAppliesTo("http://127.0.0.1:4141/")).toBe(false);
    expect(policyAppliesTo("http://localhost:3000/")).toBe(false);
  });

  it("leaves the pages that this header was breaking alone", () => {
    // GitHub sends default-src 'none' and loads its assets from a CDN ours
    // never named, so replacing its policy left the sign-in page unstyled.
    expect(policyAppliesTo("https://github.com/login")).toBe(false);
    expect(policyAppliesTo("https://github.githubassets.com/assets/light.css")).toBe(false);
    expect(policyAppliesTo("https://romeos.cc/store")).toBe(false);
  });

  it("declines anything it cannot parse", () => {
    expect(policyAppliesTo("")).toBe(false);
    expect(policyAppliesTo("about:blank")).toBe(false);
  });
});

describe("loadFailureAction", () => {
  const failure = { errorCode: -105, isMainFrame: true, onDashboard: true };

  it("reports a failed dashboard load", () => {
    expect(loadFailureAction(failure)).toBe("report");
  });

  // The private VM's dashboard used to retry these every 2 s while it
  // restarted. A hosted Rome gets the status page and its Try again instead.
  it("reports refused and offline loads instead of retrying them", () => {
    expect(loadFailureAction({ ...failure, errorCode: -102 })).toBe("report");
    expect(loadFailureAction({ ...failure, errorCode: -106 })).toBe("report");
  });

  it("ignores replaced loads, subframes, and pages off the dashboard", () => {
    expect(loadFailureAction({ ...failure, errorCode: -3 })).toBe("ignore");
    expect(loadFailureAction({ ...failure, isMainFrame: false })).toBe("ignore");
    expect(loadFailureAction({ ...failure, onDashboard: false })).toBe("ignore");
  });
});
