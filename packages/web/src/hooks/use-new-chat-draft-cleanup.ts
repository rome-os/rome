import { useLayoutEffect, useRef } from "react";
import { hasSession, useAuthStateSnapshot } from "@/lib/auth-state";
import { activateDraftOwner, clearNewChatDrafts } from "@/lib/new-chat-draft-storage";
import { useDashboardIdentity } from "./use-dashboard-identity";

/** Runs outside chat routes too; it never reads authentication storage or changes auth state. */
export function useNewChatDraftCleanup() {
  const auth = useAuthStateSnapshot();
  const { data: identity } = useDashboardIdentity({ enabled: false });
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!auth.ready || !auth.backendReachable || !auth.bootstrap) return;
    if (!hasSession(auth.bootstrap)) {
      clearNewChatDrafts();
      previous.current = null;
      return;
    }
    const owner =
      identity?.kind === "guardian"
        ? "guardian:" + identity.userId
        : identity?.kind === "visitor"
          ? "visitor:" + identity.accountId
          : null;
    if (owner && previous.current !== owner) {
      activateDraftOwner(owner);
      previous.current = owner;
    }
  }, [auth, identity]);
}
