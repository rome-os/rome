import type { BootstrapPhase } from "@rome/api-types";

export interface AuthRoutingState {
  pathname: string;
  // The backend-computed bootstrap phase is the only lifecycle
  // input the gate needs. The cloud/local sign-in distinction lives on the
  // BootstrapState payload and only affects the /login view, not routing — both
  // `needs-signin` arms route to /login — so the gate keys on the phase tag.
  phase: BootstrapPhase;
  publicAppIds?: readonly string[];
}

export type AuthRoutingDecision =
  | { action: "next" }
  | { action: "redirect"; location: string }
  | { action: "error"; status: number; message: string };

export const STATIC_PUBLIC_PATHS = [
  "/api/auth/",
  // Subsumed by "/api/auth/" above; listed so the cloud-login routes
  // are an explicit part of the public surface the auth gate waves through.
  "/api/auth/cloud/",
  "/api/oauth/",
  "/api/bootstrap",
  "/api/onboard/create-account",
  "/api/instance/enroll/",
  "/api/health",
  "/api/tailnet",
  "/api/terminal/",
  "/api/ai-tools/",
  "/callback",
  // Public, login-free shared chat is rendered outside the
  // auth shell, so the gate must never redirect it to /login.
  "/share/",
  "/ws/terminal",
  "/assets/",
  "/icon.svg",
];

export function matchesPath(pathname: string, rule: string): boolean {
  if (rule.endsWith("/")) {
    return pathname.startsWith(rule);
  }

  return pathname === rule || pathname.startsWith(`${rule}/`);
}

function matchesAny(pathname: string, rules: readonly string[]): boolean {
  return rules.some((rule) => matchesPath(pathname, rule));
}

export function isStaticPublicPath(pathname: string): boolean {
  return matchesAny(pathname, STATIC_PUBLIC_PATHS);
}

// Backend-only first-party apps whose UI lives at a fixed host route instead of
// an embedded app bundle (they ship no `web/`, so `/api/apps/<id>/manifest`
// 404s). Centralized here so routing (App.tsx), the apps grid, and auth
// classification all agree on which `/apps/<id>` paths are host pages.
export const HOST_APP_ROUTES: Record<string, string> = {
  inbox: "/apps/inbox",
};

export function getHostAppRoute(appId: string): string | null {
  return HOST_APP_ROUTES[appId] ?? null;
}

// Paths under /apps/* that are host routes, not embeddable app bundles, so they
// must never be classified as an app id — otherwise the public-app allowlist
// could expose them without a session, and the auth gate would probe a manifest
// that does not exist.
const RESERVED_APP_ROUTE_IDS = new Set(Object.keys(HOST_APP_ROUTES));

export function getRoutedAppId(pathname: string): string | null {
  const match = pathname.match(/^\/(?:full\/)?apps\/([^/]+)(?:\/|$)/);
  if (!match) return null;

  let appId: string;
  try {
    appId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  // Compare against the reserved set only after decoding: a percent-encoded id
  // (/apps/%69nbox) must not slip past the guard and re-expose a host dashboard
  // through the public-app allowlist.
  return RESERVED_APP_ROUTE_IDS.has(appId) ? null : appId;
}

export function getApiAppId(pathname: string): string | null {
  const match = pathname.match(/^\/(?:api\/apps|app-api)\/([^/]+)(?:\/|$)/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isPublicAppPath(pathname: string, publicAppIds: readonly string[]): boolean {
  const appId = getRoutedAppId(pathname) ?? getApiAppId(pathname);
  return appId !== null && publicAppIds.includes(appId);
}

export function resolveAuthRouting({
  pathname,
  phase,
  publicAppIds = [],
}: AuthRoutingState): AuthRoutingDecision {
  const isApi = pathname.startsWith("/api/");
  const isLoginPage = matchesPath(pathname, "/login");
  const isOnboardPage = matchesPath(pathname, "/onboard");
  const isConnectPage = matchesPath(pathname, "/connect");
  const isCreateAccountApi = matchesPath(pathname, "/api/onboard/create-account");

  if (isStaticPublicPath(pathname)) {
    return { action: "next" };
  }

  if (isPublicAppPath(pathname, publicAppIds)) {
    return { action: "next" };
  }

  // /connect belongs to exactly one phase; everywhere else, bounce off it and let
  // the next pass route to the phase's real destination.
  if (isConnectPage && phase !== "unenrolled") {
    return { action: "redirect", location: "/" };
  }

  switch (phase) {
    // Nothing works until the box has a durable instance
    // token. Local/desktop land on /connect to run the in-app enroll flow; the
    // enroll APIs are static-public above so it can complete.
    case "unenrolled":
      if (isConnectPage) {
        return { action: "next" };
      }
      if (isApi) {
        return { action: "error", status: 401, message: "Instance is not enrolled yet." };
      }
      return { action: "redirect", location: "/connect" };

    // Local-first box with no guardian seat: the create-account step. (Cloud
    // never reaches this — the sign-in callback creates the seat.)
    case "needs-account":
      if (isOnboardPage || isCreateAccountApi) {
        return { action: "next" };
      }
      if (isLoginPage) {
        return { action: "redirect", location: "/onboard" };
      }
      if (isApi) {
        return {
          action: "error",
          status: 401,
          message: "Guardian account has not been created yet.",
        };
      }
      return { action: "redirect", location: "/onboard" };

    // A guardian must sign in. Both the cloud and local arms route here; the
    // /login view picks the affordance off the BootstrapState payload.
    case "needs-signin":
      if (isLoginPage) {
        return { action: "next" };
      }
      if (isApi) {
        return { action: "error", status: 401, message: "Authentication required." };
      }
      return { action: "redirect", location: "/login" };

    // Authenticated mid-onboarding. Allow API access so setup can reuse existing
    // endpoints instead of a second onboarding-only API surface.
    case "needs-onboarding":
      if (isLoginPage) {
        return { action: "redirect", location: "/onboard" };
      }
      if (isOnboardPage || isApi) {
        return { action: "next" };
      }
      return { action: "redirect", location: "/onboard" };

    // Fully onboarded. /onboard is the "Enter Rome" completion moment: land on
    // the welcome-to-rome app in full mode (standalone, no dashboard chrome) — the
    // same target OnboardPage.enterRome() navigates to, so the two redirect
    // sources never disagree and race. /login goes home (/), which resolves to
    // /chat.
    case "ready":
      if (isOnboardPage) {
        return { action: "redirect", location: "/full/apps/welcome-to-rome" };
      }
      if (isLoginPage) {
        return { action: "redirect", location: "/" };
      }
      return { action: "next" };
  }
}
