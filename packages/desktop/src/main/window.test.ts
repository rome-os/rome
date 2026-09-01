import { describe, expect, it, rs } from "@rstest/core";

rs.mock("electron", () => ({
  BrowserWindow: class {},
  session: { defaultSession: { webRequest: { onHeadersReceived: rs.fn() } } },
  shell: { openExternal: rs.fn() },
}));
rs.mock("./lifecycle", () => ({ isQuitting: () => false }));

import { contentSecurityPolicy, cspSourcesForRomeCloud, policyAppliesTo } from "./window";

// Spelled out rather than imported: a wrong edit to the constant should turn
// these red, not travel through them.
const PRODUCTION = "https://romeos.cc";

describe("cspSourcesForRomeCloud", () => {
  it("names production once when that is what the build points at", () => {
    expect(cspSourcesForRomeCloud(PRODUCTION)).toBe(PRODUCTION);
  });

  it("adds a configured origin beside production", () => {
    // The dashboard's own copy is baked into the image and does not follow this
    // override, so both have to be allowed for either to work.
    expect(cspSourcesForRomeCloud("https://staging.romeos.cc")).toBe(
      `${PRODUCTION} https://staging.romeos.cc`,
    );
  });

  it("strips a path, which as a CSP source would stop matching /store", () => {
    // A pasted URL is the realistic mistake, and its symptom is the blank pane
    // this file exists to fix.
    expect(cspSourcesForRomeCloud("https://staging.example.com/app")).toBe(
      `${PRODUCTION} https://staging.example.com`,
    );
  });

  it("drops a value that would widen or rewrite the policy", () => {
    expect(cspSourcesForRomeCloud("*")).toBe(PRODUCTION);
    expect(cspSourcesForRomeCloud("https://x.com; script-src *")).toBe(PRODUCTION);
  });

  it("drops schemes that are not http(s), which URL reports as a null origin", () => {
    expect(cspSourcesForRomeCloud("javascript:alert(1)")).toBe(PRODUCTION);
    expect(cspSourcesForRomeCloud("file:///etc/passwd")).toBe(PRODUCTION);
  });

  it("drops an unusable value rather than substituting the default", () => {
    // Dropping and substituting look the same here — production is listed
    // either way — but the raw value still reaches the runtime env, so a
    // staging build with a broken origin fails where someone can see it
    // instead of quietly talking to production.
    expect(cspSourcesForRomeCloud("not a url")).toBe(PRODUCTION);
  });
});

describe("contentSecurityPolicy", () => {
  const policy = contentSecurityPolicy("https://romeos.cc");

  it("names frame-src, which frames used to reach only by falling back", () => {
    // The App Store sheet is an iframe of the cloud store. Without this
    // directive it inherits default-src, which never listed the cloud.
    expect(policy).toContain("frame-src 'self' https://romeos.cc;");
  });

  it("puts the cloud in connect-src, where Rome News fetches from", () => {
    expect(policy).toMatch(/connect-src [^;]*https:\/\/romeos\.cc;/);
  });

  it("carries the cloud in both directives, not just one", () => {
    // The two panes fail independently, so a fix that reaches only one of
    // them looks like a partial success and reads as unrelated.
    expect(policy.split("https://romeos.cc").length - 1).toBe(2);
  });

  it("keeps the directives that were already there", () => {
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("font-src 'self' data:;");
  });
});

describe("policyAppliesTo", () => {
  it("covers every document this app serves", () => {
    // The dashboard, its API, and the packaged pages. Losing any of these
    // silently drops the policy from the surface it was written for.
    expect(policyAppliesTo("http://127.0.0.1:47823/")).toBe(true);
    expect(policyAppliesTo("http://127.0.0.1:47823/settings/connections")).toBe(true);
    expect(policyAppliesTo("http://127.0.0.1:47823/api/rome-news")).toBe(true);
    expect(policyAppliesTo("file:///Applications/Rome.app/onboarding.html")).toBe(true);
  });

  it("leaves the pages that this header was breaking alone", () => {
    // GitHub sends default-src 'none' and loads its assets from a CDN ours
    // never named, so replacing its policy left the sign-in page unstyled.
    expect(policyAppliesTo("https://github.com/login")).toBe(false);
    expect(policyAppliesTo("https://github.githubassets.com/assets/light.css")).toBe(false);
    expect(policyAppliesTo("https://slack.com/oauth/v2/authorize")).toBe(false);
  });

  it("leaves Rome Cloud alone too", () => {
    // The /store frame keeps its own policy. frame-src and connect-src are
    // enforced on the dashboard document, which is still covered above.
    expect(policyAppliesTo("https://romeos.cc/store")).toBe(false);
  });

  it("matches the loopback host exactly", () => {
    // A remote host is free to wear the loopback address as a label.
    expect(policyAppliesTo("https://127.0.0.1.evil.example/")).toBe(false);
    expect(policyAppliesTo("http://127.0.0.1:47823@evil.example/")).toBe(false);
  });

  it("declines anything it cannot parse", () => {
    expect(policyAppliesTo("")).toBe(false);
    expect(policyAppliesTo("about:blank")).toBe(false);
  });
});
