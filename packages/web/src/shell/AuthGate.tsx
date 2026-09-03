import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getRoutedAppId, resolveAuthRouting } from "../lib/auth-routing";
import { BACKEND_RETRY_INTERVAL_MS, hasSession, useAuthState } from "../lib/auth-state";
import { reportDetectedTimezoneOnce } from "../lib/guardian-timezone";
import { BackendUnreachableScreen } from "../components/backend-unreachable";

interface PublicAppProbe {
  pathname: string;
  ready: boolean;
  isPublic: boolean;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [publicAppProbe, setPublicAppProbe] = useState<PublicAppProbe>({
    pathname: "",
    ready: true,
    isPublic: false,
  });

  // The single subscription to the bootstrap auth state (the gate is its sole
  // fetcher). Independent of pathname: it refetches on mount, on explicit
  // invalidation by login/logout/onboard mutations, and on a polling interval
  // only while the backend is unreachable.
  const state = useAuthState();

  // A signed-in, onboarded guardian reports the browser timezone once per page
  // load. The server adopts it only while no zone is stored.
  const ready = state.bootstrap?.phase === "ready";
  useEffect(() => {
    if (ready) void reportDetectedTimezoneOnce();
  }, [ready]);

  useEffect(() => {
    const appId = getRoutedAppId(location.pathname);
    if (!appId) {
      setPublicAppProbe({ pathname: location.pathname, ready: true, isPublic: false });
      return;
    }
    const routedAppId = appId;

    const controller = new AbortController();
    setPublicAppProbe({ pathname: location.pathname, ready: false, isPublic: false });

    async function refresh() {
      const mode = location.pathname.startsWith("/full/apps/") ? "full" : "embedded";
      const query = new URLSearchParams({ mode, path: "" });

      try {
        const response = await fetch(
          `/api/apps/${encodeURIComponent(routedAppId)}/manifest?${query}`,
          {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const manifest = response.ok ? ((await response.json()) as { isPublic?: unknown }) : null;
        if (controller.signal.aborted) return;
        setPublicAppProbe({
          pathname: location.pathname,
          ready: true,
          isPublic: manifest?.isPublic === true,
        });
      } catch {
        if (controller.signal.aborted) return;
        setPublicAppProbe({ pathname: location.pathname, ready: true, isPublic: false });
      }
    }

    void refresh();
    return () => {
      controller.abort();
    };
  }, [location.pathname]);

  if (!state.ready) {
    return null;
  }

  if (!state.backendReachable || !state.bootstrap) {
    return <BackendUnreachableScreen retryIntervalMs={BACKEND_RETRY_INTERVAL_MS} />;
  }

  const routeAppId = getRoutedAppId(location.pathname);
  const currentPublicAppProbe =
    publicAppProbe.pathname === location.pathname ? publicAppProbe : null;
  if (routeAppId && !currentPublicAppProbe?.ready && !hasSession(state.bootstrap)) {
    return null;
  }
  if (routeAppId && currentPublicAppProbe?.isPublic) {
    return <>{children}</>;
  }

  const decision = resolveAuthRouting({
    pathname: location.pathname,
    phase: state.bootstrap.phase,
  });

  if (decision.action === "redirect" && decision.location !== location.pathname) {
    return <Navigate to={decision.location} replace />;
  }

  return <>{children}</>;
}
