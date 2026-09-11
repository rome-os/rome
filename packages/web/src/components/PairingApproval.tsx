import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { pairingPayload } from "@rome/api-types/approvals";
import type { Approval } from "@/pages/ActivityPage";
import { useApprovals, useResolveApproval, APPROVALS_QUERY_KEY } from "@/hooks/use-approvals";
import { fetchJson } from "@/lib/fetch-json";
import {
  ApprovalHistoryControl,
  PairingCodeSection,
  PairingConfirmationDialog,
  PairingRequestCard,
  PairingRequestsSection,
  type PairingCodeState,
} from "./pairing/pairing-views";
import { pairingPresentation } from "./pairing/pairing-presentation";

export function PairingApproval({ approval }: { approval: Approval }) {
  const { t } = useTranslation("activity");
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [copiedCode, setCopiedCode] = useState("");
  const resolve = useResolveApproval();
  const payload = pairingPayload(approval);
  const pending = approval.status === "pending" && !!payload && payload.expiresAt > Date.now();
  const code = useQuery({
    queryKey: [...APPROVALS_QUERY_KEY, approval.id, "code"],
    queryFn: () =>
      fetchJson<{ code: string | null }>(`/api/approvals/${encodeURIComponent(approval.id)}/code`, {
        fallback: t("pairing.codeLoadFailed"),
      }),
    enabled: pending && payload.failedAttempts < 5,
    refetchInterval: pending ? 5_000 : false,
    gcTime: 0,
  });
  if (!payload) return null;
  const presentation = pairingPresentation(approval, payload, pending);
  async function decide(action: "approve" | "reject") {
    setFeedback(false);
    try {
      await resolve.mutateAsync({ id: approval.id, action });
      setConfirming(false);
    } catch {
      setFeedback(true);
    }
  }
  async function copy() {
    if (!code.data?.code) return;
    setCopyError(false);
    setCopiedCode("");
    try {
      await navigator.clipboard.writeText(code.data.code);
      setCopiedCode(code.data.code);
    } catch {
      setCopyError(true);
    }
  }
  const codeState: PairingCodeState =
    payload.failedAttempts >= 5
      ? { kind: "locked" }
      : code.data?.code
        ? {
            kind: "ready",
            code: code.data.code,
            copied: copiedCode === code.data.code,
            error: copyError,
          }
        : code.isError
          ? { kind: "error" }
          : { kind: "loading" };
  return (
    <>
      <PairingRequestCard
        {...presentation.card}
        busy={resolve.isPending ? resolve.variables?.action : null}
        error={confirming && pending ? undefined : feedback}
        onApprove={() => {
          setFeedback(false);
          setConfirming(true);
        }}
        onReject={() => void decide("reject")}
      >
        <PairingCodeSection
          {...presentation.code}
          state={codeState}
          onCopy={() => void copy()}
          onRetry={() => void code.refetch()}
        />
      </PairingRequestCard>
      <PairingConfirmationDialog
        {...presentation.confirmation}
        open={confirming && pending}
        busy={resolve.isPending}
        error={feedback}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void decide("approve")}
      />
    </>
  );
}

export function ApprovalHistoryButton() {
  const query = useApprovals();
  return (
    <ApprovalHistoryControl
      hasMore={!!query.hasNextPage}
      loading={query.isFetchingNextPage}
      error={query.isFetchNextPageError}
      onLoad={() => void query.fetchNextPage()}
    />
  );
}

export function PairingApprovals({ connectionIds }: { connectionIds?: string[] }) {
  const query = useApprovals();
  const rows =
    query.data?.filter((approval) => {
      const payload = pairingPayload(approval);
      return (
        payload &&
        approval.status === "pending" &&
        payload.expiresAt > Date.now() &&
        (!connectionIds || connectionIds.includes(payload.connectionId))
      );
    }) ?? [];
  return (
    <PairingRequestsSection
      state={
        query.isError
          ? "error"
          : query.isLoading
            ? "loading"
            : rows.length === 0
              ? "empty"
              : "ready"
      }
      onRetry={() => void query.refetch()}
      activityLink={<Link to="/activity" className="text-primary underline underline-offset-4" />}
    >
      {rows.map((approval) => (
        <PairingApproval key={approval.id} approval={approval} />
      ))}
    </PairingRequestsSection>
  );
}
