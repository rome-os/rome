import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchApproval, resolveApproval } from "@/lib/chat-api";
import { sameApproval } from "@/lib/chat-helpers";
import type { ApprovalCardStatus, ApprovalRecord } from "@/lib/chat-types";
import { deriveCardStatus, isTerminalCardStatus } from "./derive-card-status";

const BASE_INTERVAL_MS = 3_000;
const MAX_INTERVAL_MS = 60_000;
const POST_RESOLVE_REFETCH_DELAYS_MS = [250, 1000];

type Intent = "approve" | "reject";

export interface UseApprovalCardArgs {
  approvalId: string;
  initialStatus: ApprovalCardStatus;
  onResolved: () => void;
}

export interface UseApprovalCardResult {
  status: ApprovalCardStatus;
  isTerminal: boolean;
  record: ApprovalRecord | null;
  submitting: Intent | null;
  submitError: string | null;
  submit: (intent: Intent) => Promise<void>;
}

export function useApprovalCard({
  approvalId,
  initialStatus,
  onResolved,
}: UseApprovalCardArgs): UseApprovalCardResult {
  const { t } = useTranslation("chat");
  const [record, setRecord] = useState<ApprovalRecord | null>(null);
  const [submitting, setSubmitting] = useState<Intent | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const status = deriveCardStatus(initialStatus, record);
  const isTerminal = isTerminalCardStatus(status);
  const resolvedFiredRef = useRef(false);
  const refetchRef = useRef<(() => void) | null>(null);

  // Stabilize onResolved via a ref so the polling effect below doesn't tear
  // down + restart every render just because the parent passed a new closure.
  const onResolvedRef = useRef(onResolved);
  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let loaded = false;

    const computeDelay = () => {
      // Exponential backoff on consecutive failures so dropped server / tab
      // throttling doesn't pile up doomed requests.
      return Math.min(MAX_INTERVAL_MS, BASE_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 5));
    };

    const fetchState = async () => {
      try {
        const data = await fetchApproval(approvalId);
        if (!data) {
          consecutiveFailures += 1;
          return;
        }
        consecutiveFailures = 0;
        loaded = true;
        if (cancelled) return;
        // Reuse prior reference when nothing observable changed so children
        // memoized on `record` don't re-render every 3s.
        setRecord((prev) => (sameApproval(prev, data) ? prev : data));
      } catch {
        consecutiveFailures += 1;
      }
    };

    refetchRef.current = () => {
      void fetchState();
    };

    const tick = async () => {
      if (cancelled) return;
      // Skip work while the tab is hidden — cheap server, cheap battery. The
      // visibilitychange listener below kicks a fresh fetch when the user
      // comes back. A card that has never loaded still fetches, so a card
      // that arrives in a background tab can flag the tab as waiting.
      if (loaded && typeof document !== "undefined" && document.visibilityState === "hidden") {
        if (!isTerminal) timer = setTimeout(tick, BASE_INTERVAL_MS);
        return;
      }
      await fetchState();
      if (cancelled || isTerminal) return;
      timer = setTimeout(tick, computeDelay());
    };

    void tick();
    if (isTerminal) {
      // Terminal cards still fetch once to settle their final state, but we
      // skip the visibility listener + recurring timer entirely.
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        refetchRef.current = null;
      };
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !cancelled) {
        void fetchState();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      refetchRef.current = null;
    };
  }, [approvalId, isTerminal]);

  useEffect(() => {
    if (!isTerminal || resolvedFiredRef.current) return;
    resolvedFiredRef.current = true;
    onResolvedRef.current();
  }, [isTerminal]);

  const submit = async (intent: Intent) => {
    setSubmitting(intent);
    setSubmitError(null);
    try {
      const result = await resolveApproval(approvalId, intent);
      if (!result.ok) {
        setSubmitError(
          result.error ??
            t(
              intent === "approve"
                ? "approvals.errors.approveStatus"
                : "approvals.errors.rejectStatus",
              { status: result.status },
            ),
        );
        return;
      }
      // Optimistic update so the badge/buttons flip immediately instead of
      // briefly reverting to "Approve" while we wait for the next 3s poll.
      setRecord((prev) => {
        if (intent === "approve") {
          return {
            id: approvalId,
            status: "approved",
            executionState: prev?.executionState ?? "queued",
            executionError: null,
          };
        }
        return {
          id: approvalId,
          status: "rejected",
          executionState: prev?.executionState ?? null,
          executionError: prev?.executionError ?? null,
        };
      });
      // Pull fresh state quickly to confirm + catch the executionState
      // transition from queued → succeeded without waiting for next poll.
      for (const delay of POST_RESOLVE_REFETCH_DELAYS_MS) {
        setTimeout(() => refetchRef.current?.(), delay);
      }
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : t(
              intent === "approve"
                ? "approvals.errors.approveFallback"
                : "approvals.errors.rejectFallback",
            ),
      );
    } finally {
      setSubmitting(null);
    }
  };

  return { status, isTerminal, record, submitting, submitError, submit };
}
