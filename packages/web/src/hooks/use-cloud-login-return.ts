import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStateSnapshot } from "@/lib/auth-state";
import { peekLoginReturn, takeLoginReturn } from "@/lib/login-return";

/**
 * Rome Cloud sign-in finishes with a server redirect to `/?cloud=success`
 * (api/routes/cloud-login.ts), which no sign-in page sees. Once the session
 * is ready there, this names the page the guardian was sent to /login from.
 * Mounted above the routes so the `/` → `/chat` redirect cannot win first.
 */
export function useCloudLoginReturn(): string | null {
  const { pathname, search } = useLocation();
  const { bootstrap } = useAuthStateSnapshot();
  const landed =
    bootstrap?.phase === "ready" &&
    pathname === "/" &&
    new URLSearchParams(search).get("cloud") === "success";

  // Cleared after the redirect renders, so a repeated render still reads it.
  useEffect(() => {
    if (landed) takeLoginReturn();
  }, [landed]);

  if (!landed) return null;
  const target = peekLoginReturn();
  return target === "/" ? null : target;
}
