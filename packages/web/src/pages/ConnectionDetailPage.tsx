import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { StatusIndicator } from "@/lib/connection-status";
import { ConnectionDetailBody } from "@/components/ConnectionDetail";
import { buildConnectionCards } from "@/lib/connection-cards";
import { CONNECTIONS_REFRESH_INTERVAL_MS, fetchConnections } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";
import { PageShell, PageBody, PageHeader } from "@/shell/PageShell";

/**
 * Per-service Connection detail page (`/settings/connections/:serviceId`).
 *
 * Self-loads `GET /api/connections` (plus the Composio account status for the
 * broker card), folds it through the `buildConnectionCards` presentation
 * adapter, and resolves the card matching `:serviceId`. Unknown or unmatched
 * ids redirect back to the list. The connect ceremony + enablement copy is the
 * shared `ConnectionDetailBody` (also used by the in-list dialog).
 */

const BACK_TO_LIST = "/settings/connections";

const CONNECTIONS_QUERY_KEY = ["connection-detail", "connections"] as const;
const COMPOSIO_QUERY_KEY = ["connection-detail", "composio"] as const;

function useConnections() {
  return useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: fetchConnections,
    refetchInterval: CONNECTIONS_REFRESH_INTERVAL_MS,
  });
}

function useComposioStatus() {
  return useQuery<ComposioCliStatus | null>({
    queryKey: COMPOSIO_QUERY_KEY,
    queryFn: async () => {
      const payload = await fetchJson<{ composio?: ComposioCliStatus | null }>(
        "/api/integrations/composio/status",
        { fallback: "Failed to load Composio status." },
      );
      return payload.composio ?? null;
    },
  });
}

export default function ConnectionDetailPage() {
  const { serviceId } = useParams<{ serviceId: string }>();

  const connectionsQuery = useConnections();
  const composioQuery = useComposioStatus();

  const loading = connectionsQuery.isLoading || composioQuery.isLoading;

  const refresh = () => {
    void connectionsQuery.refetch();
    void composioQuery.refetch();
  };
  const flash = (message: string) => toast(message);

  // The Telegram personal account folded onto the Telegram connection as a slot;
  // its old standalone route redirects to the merged Telegram detail.
  if (serviceId === "telegram-user") {
    return <Navigate to={`${BACK_TO_LIST}/telegram`} replace />;
  }

  if (loading) {
    return <DetailSkeleton />;
  }

  if (connectionsQuery.isError) {
    return (
      <PageShell>
        <div className="max-w-2xl">
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load this connection</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {connectionsQuery.error instanceof Error
                  ? connectionsQuery.error.message
                  : "Failed to load connections."}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void connectionsQuery.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </PageShell>
    );
  }

  const composio = composioQuery.data ?? null;
  const cards = buildConnectionCards(connectionsQuery.data ?? [], composio);
  const card = cards.find((entry) => entry.service === serviceId);

  // Unknown / unmatched service id — back to the list.
  if (!card) {
    return <Navigate to={BACK_TO_LIST} replace />;
  }

  return (
    <PageShell>
      <PageBody className="max-w-2xl">
        <div className="space-y-4">
          <Link
            to={BACK_TO_LIST}
            className="inline-flex items-center gap-2 text-ui text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Connections
          </Link>
          <PageHeader
            leading={<ConnectionBrandBadge connection={card.service} />}
            title={card.label}
            description={<StatusIndicator card={card} />}
          />
        </div>

        <ConnectionDetailBody card={card} composio={composio} onRefresh={refresh} onFlash={flash} />
      </PageBody>
    </PageShell>
  );
}

function DetailSkeleton() {
  return (
    <PageShell>
      {/* Same rhythm as the loaded view's PageBody, so settling from skeleton
          to content does not shift the rows. */}
      <PageBody className="max-w-2xl">
        <div className="space-y-4">
          <Skeleton className="h-5 w-28" />
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-8" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
        </div>
        <Skeleton className="h-28 w-full rounded-8" />
        <Skeleton className="h-16 w-full rounded-8" />
      </PageBody>
    </PageShell>
  );
}
