export interface StartupSurfaceOnboarding {
  kind: "onboarding";
}

export interface StartupSurfaceDashboard {
  kind: "dashboard";
  url: string;
}

export type StartupSurface = StartupSurfaceOnboarding | StartupSurfaceDashboard;

// Enrollment belongs to the dashboard and its token is stored by core, so the
// window opens the Rome once it is ready, and the welcome page (sign in, pick
// a Rome, wait on Rome Cloud) until then.
export function chooseStartupSurface(dashboardUrl: string, ready: boolean): StartupSurface {
  return ready ? { kind: "dashboard", url: dashboardUrl } : { kind: "onboarding" };
}

// Whether the "Web Dashboard" menu item should navigate rather than only raise
// the window. A provider's OAuth page takes over the whole window and this
// frameless shell carries no back affordance, so the menu item is the way home.
// Already on the dashboard it stays put, because reloading would discard an
// in-progress compose.
//
// Origins, not prefixes: `https://ray.romeos.cc@evil.example/` carries the
// dashboard in its user-info and belongs to evil.example. Anything unparseable
// navigates — the escape hatch fails toward escaping.
export function shouldReturnToDashboard(currentUrl: string, dashboardUrl: string): boolean {
  try {
    return new URL(currentUrl).origin !== new URL(dashboardUrl).origin;
  } catch {
    return true;
  }
}

export function shouldAutoOpenDashboard(
  currentUrl: string,
  onboardingUrl: string,
  dashboardUrl: string,
): boolean {
  if (!currentUrl || currentUrl === "about:blank") {
    return true;
  }

  return currentUrl.startsWith(onboardingUrl) || currentUrl.startsWith(dashboardUrl);
}
