import { useRef } from "react";
import { type Location, matchPath, useLocation, useNavigate } from "react-router-dom";
import { MAIN_CHAT_PATH } from "@/lib/chat-session";

type Backdrop = Pick<Location, "pathname" | "search" | "hash" | "state" | "key">;

function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

// App's routes that only redirect, and the auth pages AuthGate sends a signed-in
// guardian away from. Rendered behind Settings, their redirect would move the
// real address and close it.
const REDIRECT_ONLY = [
  "/",
  "/login",
  "/onboard",
  "/connect",
  "/callback",
  "/chat/concierge",
  "/activity",
  "/people",
  "/people/latest",
  "/events",
  "/guide",
  "/apps/inbox/:rest/*",
  "/full/apps/inbox/*",
];

function redirectsAway(pathname: string): boolean {
  return REDIRECT_ONLY.some((pattern) => matchPath(pattern, pathname));
}

/**
 * Settings opens as a dialog over the page the guardian came from, so while a
 * `/settings` address is showing, `backdrop` is that page's location for the
 * app's routes to keep rendering. `close` returns to it with its search, hash
 * and state. A fresh load has no such page, and a page that only redirects
 * cannot stand behind, so the main chat stands in.
 */
export function useSettingsBackdrop() {
  const location = useLocation();
  const navigate = useNavigate();
  const settingsOpen = isSettingsPath(location.pathname);
  const behind = useRef<Backdrop | null>(null);
  if (!settingsOpen && !redirectsAway(location.pathname)) behind.current = location;
  // Fixed on the first settings render: the section links drop the query, and
  // the shell flag has to outlive them.
  const backdrop: Backdrop = (behind.current ??= {
    pathname: MAIN_CHAT_PATH,
    search: new URLSearchParams(location.search).get("hideSidebar") === "1" ? "?hideSidebar=1" : "",
    hash: "",
    state: null,
    key: "settings-backdrop",
  });
  return {
    settingsOpen,
    backdrop: settingsOpen ? backdrop : location,
    close: () => {
      const { pathname, search, hash, state } = backdrop;
      navigate({ pathname, search, hash }, { state });
    },
  };
}
