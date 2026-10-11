import { useQuery } from "@tanstack/react-query";
import type { BootstrapState } from "@rome/api-types";

export const AUTH_QUERY_KEY = ["auth-state"] as const;

export const BACKEND_RETRY_INTERVAL_MS = 5_000;

export interface AuthState {
  ready: boolean;
  backendReachable: boolean;
  // The lifecycle is a single discriminated state computed by
  // the backend (`GET /api/bootstrap`). Null until the probe resolves or when the
  // backend is unreachable. The gate switches on `bootstrap.phase`.
  bootstrap: BootstrapState | null;
}

export const INITIAL_AUTH_STATE: AuthState = Object.freeze({
  ready: false,
  backendReachable: true,
  bootstrap: null,
});

const UNREACHABLE_STATE: AuthState = Object.freeze({
  ready: true,
  backendReachable: false,
  bootstrap: null,
});

// Whether the bootstrap state implies an authenticated guardian session. Both
// post-sign-in phases carry a session; the pre-sign-in ones don't.
export function hasSession(bootstrap: BootstrapState | null): boolean {
  return bootstrap?.phase === "needs-onboarding" || bootstrap?.phase === "ready";
}

export async function fetchAuthState({
  signal,
}: {
  signal?: AbortSignal;
} = {}): Promise<AuthState> {
  // Two parallel probes. The bootstrap state folds in session + onboarding +
  // enrollment, so there's no separate /api/auth/session round trip anymore.
  // When the backend is unreachable, bootstrap fails as fast as health does.
  const [healthRes, bootstrapRes] = await Promise.allSettled([
    fetch("/api/health", { signal }),
    fetch("/api/bootstrap", { credentials: "include", signal }),
  ]);

  const healthy = healthRes.status === "fulfilled" && healthRes.value.ok;
  if (!healthy) return UNREACHABLE_STATE;

  // A bootstrap probe that didn't even reach the server (network error, abort)
  // means the backend is unreachable — don't route off a half-broken response.
  if (bootstrapRes.status === "rejected" || !bootstrapRes.value.ok) {
    return UNREACHABLE_STATE;
  }

  try {
    const bootstrap = (await bootstrapRes.value.json()) as BootstrapState;
    return { ready: true, backendReachable: true, bootstrap };
  } catch {
    return UNREACHABLE_STATE;
  }
}

// The single fetcher of the bootstrap auth state, owned by the auth gate. Lives
// in react-query and is **independent of pathname**: it refetches on mount, on
// explicit invalidation by login/logout/onboard mutations, and on a polling
// interval only while the backend is unreachable.
export function useAuthState(): AuthState {
  const { data } = useQuery<AuthState>({
    queryKey: AUTH_QUERY_KEY,
    queryFn: ({ signal }) => fetchAuthState({ signal }),
    staleTime: Infinity,
    refetchInterval: (query) =>
      query.state.data && !query.state.data.backendReachable ? BACKEND_RETRY_INTERVAL_MS : false,
  });
  return data ?? INITIAL_AUTH_STATE;
}

// A read-only view of the auth state for components rendered *under* the auth
// gate (the login/connect pages). It subscribes to the same cache but never
// triggers a fetch — the gate is the sole fetcher and has already populated the
// cache by the time these pages mount, so a page reading state must not kick off
// a second bootstrap round (which it would in isolation, e.g. unit tests).
export function useAuthStateSnapshot(): AuthState {
  const { data } = useQuery<AuthState>({
    queryKey: AUTH_QUERY_KEY,
    queryFn: ({ signal }) => fetchAuthState({ signal }),
    enabled: false,
    staleTime: Infinity,
  });
  return data ?? INITIAL_AUTH_STATE;
}
