import { describe, expect, it } from "@rstest/core";
import { getRoutedAppId, isPublicAppPath, resolveAuthRouting } from "@/lib/auth-routing";

describe("resolveAuthRouting", () => {
  describe("unenrolled", () => {
    it("redirects to /connect", () => {
      expect(resolveAuthRouting({ pathname: "/", phase: "unenrolled" })).toEqual({
        action: "redirect",
        location: "/connect",
      });
    });

    it("allows /connect", () => {
      expect(resolveAuthRouting({ pathname: "/connect", phase: "unenrolled" })).toEqual({
        action: "next",
      });
    });

    it("errors non-public API calls", () => {
      expect(resolveAuthRouting({ pathname: "/api/settings", phase: "unenrolled" })).toEqual({
        action: "error",
        status: 401,
        message: "Instance is not enrolled yet.",
      });
    });

    it("allows the enroll API (static-public)", () => {
      expect(
        resolveAuthRouting({ pathname: "/api/instance/enroll/start", phase: "unenrolled" }),
      ).toEqual({ action: "next" });
    });
  });

  describe("needs-account", () => {
    it("redirects to /onboard", () => {
      expect(resolveAuthRouting({ pathname: "/", phase: "needs-account" })).toEqual({
        action: "redirect",
        location: "/onboard",
      });
    });

    it("allows /onboard and the create-account API", () => {
      expect(resolveAuthRouting({ pathname: "/onboard", phase: "needs-account" })).toEqual({
        action: "next",
      });
      expect(
        resolveAuthRouting({ pathname: "/api/onboard/create-account", phase: "needs-account" }),
      ).toEqual({ action: "next" });
    });

    it("redirects /login to /onboard", () => {
      expect(resolveAuthRouting({ pathname: "/login", phase: "needs-account" })).toEqual({
        action: "redirect",
        location: "/onboard",
      });
    });

    it("redirects an enrolled box off /connect", () => {
      expect(resolveAuthRouting({ pathname: "/connect", phase: "needs-account" })).toEqual({
        action: "redirect",
        location: "/",
      });
    });
  });

  describe("needs-signin", () => {
    it("redirects to /login", () => {
      expect(resolveAuthRouting({ pathname: "/", phase: "needs-signin" })).toEqual({
        action: "redirect",
        location: "/login",
      });
    });

    it("allows /login", () => {
      expect(resolveAuthRouting({ pathname: "/login", phase: "needs-signin" })).toEqual({
        action: "next",
      });
    });

    it("errors API calls", () => {
      expect(resolveAuthRouting({ pathname: "/api/settings", phase: "needs-signin" })).toEqual({
        action: "error",
        status: 401,
        message: "Authentication required.",
      });
    });

    it("redirects /connect to / (no role in this phase)", () => {
      expect(resolveAuthRouting({ pathname: "/connect", phase: "needs-signin" })).toEqual({
        action: "redirect",
        location: "/",
      });
    });
  });

  describe("needs-onboarding", () => {
    it("redirects to /onboard", () => {
      expect(resolveAuthRouting({ pathname: "/settings", phase: "needs-onboarding" })).toEqual({
        action: "redirect",
        location: "/onboard",
      });
    });

    it("allows /onboard", () => {
      expect(resolveAuthRouting({ pathname: "/onboard", phase: "needs-onboarding" })).toEqual({
        action: "next",
      });
    });

    it("allows API access so onboarding can reuse existing endpoints", () => {
      expect(
        resolveAuthRouting({ pathname: "/api/connections", phase: "needs-onboarding" }),
      ).toEqual({ action: "next" });
    });

    it("redirects /login to /onboard", () => {
      expect(resolveAuthRouting({ pathname: "/login", phase: "needs-onboarding" })).toEqual({
        action: "redirect",
        location: "/onboard",
      });
    });
  });

  describe("ready", () => {
    it("allows normal app access", () => {
      expect(resolveAuthRouting({ pathname: "/settings", phase: "ready" })).toEqual({
        action: "next",
      });
    });

    it("redirects /login home", () => {
      expect(resolveAuthRouting({ pathname: "/login", phase: "ready" })).toEqual({
        action: "redirect",
        location: "/",
      });
    });

    it("redirects the /onboard completion moment to the welcome app", () => {
      // Must match OnboardPage.enterRome()'s target so the two redirect sources
      // never disagree and race.
      expect(resolveAuthRouting({ pathname: "/onboard", phase: "ready" })).toEqual({
        action: "redirect",
        location: "/full/apps/welcome-to-rome",
      });
    });

    it("does not redirect a guardian sitting on the full welcome screen (fixed point)", () => {
      expect(
        resolveAuthRouting({ pathname: "/full/apps/welcome-to-rome", phase: "ready" }),
      ).toEqual({ action: "next" });
    });
  });

  describe("static-public and public-app paths (phase-independent)", () => {
    it("allows OAuth callback pages before sign-in", () => {
      expect(resolveAuthRouting({ pathname: "/callback", phase: "needs-signin" })).toEqual({
        action: "next",
      });
    });

    it("allows public app routes before a session exists", () => {
      expect(
        resolveAuthRouting({
          pathname: "/apps/weather/thread/1",
          phase: "needs-signin",
          publicAppIds: ["weather"],
        }),
      ).toEqual({ action: "next" });
    });

    it("keeps private app routes behind sign-in", () => {
      expect(
        resolveAuthRouting({
          pathname: "/apps/private-app",
          phase: "needs-signin",
          publicAppIds: ["weather"],
        }),
      ).toEqual({ action: "redirect", location: "/login" });
    });
  });

  describe("reserved app-route guards", () => {
    it("does not treat the app store or inbox host routes as app ids", () => {
      expect(getRoutedAppId("/apps/store")).toBeNull();
      expect(getRoutedAppId("/apps/inbox")).toBeNull();
      expect(isPublicAppPath("/apps/inbox", ["inbox"])).toBe(false);
    });

    it("blocks percent-encoded spellings of reserved host routes", () => {
      expect(getRoutedAppId("/apps/%69nbox")).toBeNull();
      expect(getRoutedAppId("/apps/%73tore")).toBeNull();
    });
  });
});
