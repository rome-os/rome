import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const HOST_NAVIGATE_EVENT = "rome:host-navigate";

interface HostNavigateDetail {
  path?: string;
  state?: unknown;
}

/**
 * Bridge `navigateRome(payload)` / `startChat` (from `@rome-os/app-web-sdk`)
 * into real react-router navigations. Apps mount in a Shadow DOM that shares the
 * host `window`, so the SDK dispatches a `rome:host-navigate` CustomEvent. Chat
 * and session routes from workspace iframes are forwarded with postMessage and
 * handled here too. Both paths become soft navigations — no full page reload,
 * no state loss.
 *
 * Mounted once at the app root (see `App`), so it covers every surface: the
 * dashboard shell, full-mode app pages (which render outside the shell), and the
 * standalone auth/onboarding pages alike. iframe messages stay allow-listed to
 * chat and session routes; same-window CustomEvents come from the loaded SDK.
 */
export function useHostNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    function navigateToDetail(detail: HostNavigateDetail | undefined) {
      if (typeof detail?.path === "string" && detail.path.length > 0) {
        // `state` becomes location.state on the target route (e.g. a chat
        // composer draft from `navigateRome({ path: "chat/new", draft })`).
        navigate(detail.path, detail.state !== undefined ? { state: detail.state } : undefined);
      }
    }

    function onHostNavigate(event: Event) {
      navigateToDetail((event as CustomEvent<HostNavigateDetail>).detail);
    }

    function onHostNavigateMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; detail?: HostNavigateDetail } | null;
      if (!data || typeof data !== "object" || data.type !== HOST_NAVIGATE_EVENT) return;
      const path = data.detail?.path;
      if (path !== "/chat" && !path?.startsWith("/chat/") && !path?.startsWith("/sessions/")) {
        return;
      }
      navigateToDetail(data.detail);
    }

    window.addEventListener(HOST_NAVIGATE_EVENT, onHostNavigate);
    window.addEventListener("message", onHostNavigateMessage);
    return () => {
      window.removeEventListener(HOST_NAVIGATE_EVENT, onHostNavigate);
      window.removeEventListener("message", onHostNavigateMessage);
    };
  }, [navigate]);
}
