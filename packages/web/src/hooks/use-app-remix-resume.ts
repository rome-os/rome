import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import type { AppRemixStoreIntent } from "@rome/api-types/apps";
import { useAuthStateSnapshot } from "@/lib/auth-state";
import { parseRemixIntent, parseRemixSearch } from "@/lib/app-remix";

const STORAGE_KEY = "rome:pending-app-remix";
const INTENT_LIFETIME_MS = 15 * 60 * 1000;
const AUTH_LANDING_PATHS = new Set([
  "/",
  "/chat",
  "/login",
  "/connect",
  "/onboard",
  // Where a first Cloud sign-in lands.
  `/chat/${CONCIERGE_CHAT_ID}`,
]);

interface PendingIntent {
  intent: AppRemixStoreIntent;
  expiresAt: number;
}

function readPending(): PendingIntent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) return null;
    const intent = parseRemixIntent(value.intent);
    return intent ? { intent, expiresAt: value.expiresAt } : null;
  } catch {
    return null;
  }
}

/** Keeps only a validated Store intent across same-tab password or Cloud login. */
export function useAppRemixResume(): string | null {
  const { pathname, search } = useLocation();
  const { bootstrap } = useAuthStateSnapshot();
  const ready = bootstrap?.phase === "ready";
  const [pending, setPending] = useState(readPending);

  useEffect(() => {
    if (pathname === "/remix-app" && !ready) {
      const intent = parseRemixSearch(new URLSearchParams(search));
      const next = intent ? { intent, expiresAt: Date.now() + INTENT_LIFETIME_MS } : null;
      setPending(next);
      try {
        if (next) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        else sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* The mounted App still retains the intent when storage is unavailable. */
      }
    } else if (ready && (pathname === "/remix-app" || !AUTH_LANDING_PATHS.has(pathname))) {
      setPending(null);
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* Storage may be disabled. */
      }
    }
  }, [pathname, search, ready]);

  return ready && pending && pending.expiresAt > Date.now() && AUTH_LANDING_PATHS.has(pathname)
    ? `/remix-app?${new URLSearchParams(pending.intent)}`
    : null;
}
