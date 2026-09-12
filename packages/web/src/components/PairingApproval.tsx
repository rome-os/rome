import { useState, useRef } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { pairingPayload } from "@rome/api-types/approvals";
import type { Approval } from "@/pages/ActivityPage";
import { useApprovals, useResolveApproval, APPROVALS_QUERY_KEY } from "@/hooks/use-approvals";
import { fetchJson } from "@/lib/fetch-json";
import { serviceLabel } from "@/lib/connection-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

export function PairingApproval({ approval }: { approval: Approval }) {
  const { t, i18n } = useTranslation("activity");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [copiedCode, setCopiedCode] = useState("");
  const resolve = useResolveApproval();
  const payload = pairingPayload(approval);
  const pending = approval.status === "pending" && !!payload && payload.expiresAt > Date.now();
  const code = useQuery({
    queryKey: [...APPROVALS_QUERY_KEY, approval.id, "code"],
    queryFn: () =>
      fetchJson<{ code: string | null }>(`/api/approvals/${encodeURIComponent(approval.id)}/code`, {
        fallback: t("pairing.loadFailed"),
      }),
    enabled: pending && payload.failedAttempts < 5,
    refetchInterval: pending ? 5_000 : false,
    gcTime: 0,
  });
  if (!payload) return null;
  const account = `${payload.displayName || payload.channelUserId} (${payload.channelUserId})`;
  const channel = serviceLabel(payload.channel);
  const validityMinutes = Math.max(
    0,
    Math.round((payload.expiresAt - new Date(approval.createdAt).getTime()) / 60_000),
  );
  const validity = new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: "unit",
    unit: validityMinutes >= 60 ? "hour" : "minute",
    unitDisplay: "long",
    maximumFractionDigits: 1,
  }).format(validityMinutes >= 60 ? validityMinutes / 60 : validityMinutes);
  async function decide(action: "approve" | "reject") {
    setFeedback("");
    try {
      await resolve.mutateAsync({ id: approval.id, action });
      setConfirming(false);
    } catch {
      setFeedback(t("pairing.resolveFailed"));
    }
  }
  async function copy() {
    if (!code.data?.code) return;
    setFeedback("");
    setCopiedCode("");
    try {
      await navigator.clipboard.writeText(code.data.code);
      setCopiedCode(code.data.code);
    } catch {
      setFeedback(t("pairing.copyFailed"));
    }
  }
  return (
    <section
      className="flex flex-col gap-3 rounded-8 border border-border bg-surface p-4"
      aria-label={t("pairing.account", { account })}
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="break-words text-title">{payload.displayName || payload.channelUserId}</h3>
          <Badge variant="outline" className="break-all text-muted-foreground">
            ID {payload.channelUserId}
          </Badge>
        </div>
        <p className="text-ui text-muted-foreground">{channel}</p>
      </div>
      <p className="text-aux text-muted-foreground">
        {t("pairing.requested", { time: new Date(approval.createdAt).toLocaleString() })}
        {" · "}
        {t("pairing.validity", { duration: validity })}
      </p>
      {pending ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={resolve.isPending}
              onClick={() => {
                setFeedback("");
                setConfirming(true);
              }}
            >
              {t("pairing.approve")}
            </Button>
            <Button
              variant="outline"
              disabled={resolve.isPending}
              onClick={() => void decide("reject")}
            >
              {t("pairing.reject")}
            </Button>
          </div>
          <details className="group border-t border-border pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-4 text-ui text-muted-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 group-open:rotate-90" aria-hidden="true" />
              {t("pairing.codeAlternative")}
            </summary>
            <div className="mt-3 flex flex-col gap-2">
              {code.data?.code && payload.failedAttempts < 5 ? (
                <div className="flex flex-wrap items-center gap-3">
                  <code className="break-all text-title" aria-label={t("pairing.code")}>
                    {code.data.code}
                  </code>
                  <Button
                    variant="outline"
                    onClick={() => void copy()}
                    aria-label={t(
                      copiedCode === code.data.code ? "pairing.copied" : "pairing.copy",
                    )}
                  >
                    {copiedCode === code.data.code ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Copy aria-hidden="true" />
                    )}
                    {t("pairing.copy")}
                  </Button>
                </div>
              ) : (
                <p className="text-ui">
                  {payload.failedAttempts >= 5
                    ? t("pairing.locked")
                    : code.isError
                      ? t("pairing.loadFailed")
                      : t("pairing.loading")}
                </p>
              )}
              <p className="text-ui text-muted-foreground">
                {t("pairing.destination", {
                  channel,
                  account: payload.displayName || t("pairing.thisAccount"),
                })}
              </p>
            </div>
          </details>
        </>
      ) : (
        <p className="text-ui">
          {t(
            `pairing.${approval.status === "approved" ? "approved" : payload.resolution === "expired" || approval.status === "pending" ? "expired" : "rejected"}`,
          )}
        </p>
      )}
      <p role="status" className={feedback ? "text-ui" : "sr-only"}>
        {feedback}
      </p>
      {approval.resolvedBy && (
        <p className="text-aux text-muted-foreground">
          {t("pairing.resolved", {
            actor: approval.resolvedBy,
            time: approval.resolvedAt ? new Date(approval.resolvedAt).toLocaleString() : "",
          })}
        </p>
      )}
      <Dialog
        open={confirming && pending}
        onClose={() => {
          if (!resolve.isPending) setConfirming(false);
        }}
        initialFocusRef={cancelRef}
        modal={resolve.isPending}
        className="max-w-[calc(100vw-2rem)] sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{t("pairing.confirmTitle")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>{t("pairing.confirmBody", { channel, account })}</DialogDescription>
          {feedback && <p role="alert">{feedback}</p>}
        </DialogBody>
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => setConfirming(false)}
          >
            {t("pairing.cancel")}
          </Button>
          <Button disabled={resolve.isPending} onClick={() => void decide("approve")}>
            {t("pairing.approve")}
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}

export function ApprovalHistoryButton() {
  const query = useApprovals();
  const { t } = useTranslation("activity");
  if (!query.hasNextPage) return null;
  return (
    <div>
      {query.isFetchNextPageError && <p role="alert">{t("pairing.loadFailed")}</p>}
      <Button
        variant="outline"
        disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        {t(query.isFetchingNextPage ? "pairing.loading" : "pairing.loadHistory")}
      </Button>
    </div>
  );
}

export function PairingApprovals({ connectionIds }: { connectionIds?: string[] }) {
  const { t } = useTranslation("activity");
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
    <section className="space-y-3" aria-label={t("pairing.title")}>
      <h2 className="text-title">{t("pairing.title")}</h2>
      {query.isError ? (
        <div role="alert">
          <p>{t("pairing.loadFailed")}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t("pairing.retry")}
          </Button>
        </div>
      ) : query.isLoading ? (
        <p role="status">{t("pairing.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          <Trans
            t={t}
            i18nKey="pairing.empty"
            components={{
              activity: (
                <Link to="/activity" className="text-primary underline underline-offset-4" />
              ),
            }}
          />
        </p>
      ) : (
        rows.map((approval) => <PairingApproval key={approval.id} approval={approval} />)
      )}
      {(query.isLoading || query.isError || rows.length > 0) && (
        <Link to="/activity" className="text-ui text-primary underline underline-offset-4">
          {t("pairing.viewActivity")}
        </Link>
      )}
    </section>
  );
}
