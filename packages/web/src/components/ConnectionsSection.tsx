import { PairingApprovals } from "./PairingApproval";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, RefreshCw, Unplug } from "lucide-react";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { AppKeysRow } from "@/components/connections/app-keys-row";
import { ConnectionDetailDialog } from "@/components/ConnectionDetail";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { buildConnectionCards } from "@/lib/connection-cards";
import { StatusIndicator } from "@/lib/connection-status";
import type { ApiConnection } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";

/**
 * Unified Connections list (list of rows).
 *
 * Renders every service the registry reports — Talk channels, OAuth services,
 * and the Composio broker account — as one uniform list over
 * `GET /api/connections`. Each row is a full-width button showing the brand
 * badge + label on the left and a dot+text `StatusIndicator` on the right;
 * clicking it opens the `ConnectionDetailDialog` over the list, where the
 * connect ceremony lives. The list itself performs NO ceremony — no inline
 * connect/disconnect, no expand-in-place cards, no accordion.
 *
 * The list closes with the `AppKeysRow` — the app-keys vault is not a registry
 * service, but it lives on this surface, so it renders in the same row anatomy
 * and navigates to its own page. It self-loads and stays up whatever state the
 * registry request is in.
 */
export function ConnectionsSection({
  connections,
  composio,
  loading = false,
  error = null,
  onRetry,
  onRefresh,
  onFlash,
}: {
  connections: ApiConnection[];
  composio: ComposioCliStatus | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void | Promise<void>;
  /** Re-fetch `/api/connections` + the Composio status after a ceremony. */
  onRefresh?: () => void | Promise<void>;
  onFlash?: (message: string) => void;
}) {
  const { t } = useTranslation("settings");
  const cards = buildConnectionCards(connections, composio);

  // Which row's detail dialog is open (null = closed). Track the service, not
  // the card object, so a refresh mid-dialog re-derives the LIVE card.
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const selected = cards.find((card) => card.service === selectedService) ?? null;

  return (
    <div className="space-y-6">
      <PairingApprovals />
      <div>
        <h2 className="text-title text-foreground">Connections</h2>
        <p className="mt-1 text-body text-muted-foreground">
          Every channel and service your agent can use, in one place. Open one to connect it and see
          what it enables.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {loading ? (
          <div className="flex flex-col gap-2" role="status" aria-label={t("connections.loading")}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertTitle>{t("connections.errorTitle")}</AlertTitle>
            <AlertDescription>
              <p>{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void onRetry?.()}
              >
                <RefreshCw aria-hidden />
                {t("page.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : cards.length === 0 ? (
          <EmptyState className="rounded-8 border border-dashed border-border bg-surface/50">
            <EmptyStateIcon>
              <Unplug aria-hidden />
            </EmptyStateIcon>
            <EmptyStateTitle>{t("connections.emptyTitle")}</EmptyStateTitle>
          </EmptyState>
        ) : (
          cards.map((card) => (
            <Button
              key={card.service}
              type="button"
              variant="outline"
              size="default"
              align="between"
              onClick={() => setSelectedService(card.service)}
              className="h-auto w-full bg-surface py-3 text-left hover:bg-accent"
              aria-label={`Open ${card.label}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <ConnectionBrandBadge connection={card.service} />
                <span className="truncate text-ui text-foreground">{card.label}</span>
              </span>
              <StatusIndicator card={card} />
            </Button>
          ))
        )}
        <AppKeysRow />
      </div>

      <ConnectionDetailDialog
        card={selected}
        composio={composio}
        onClose={() => setSelectedService(null)}
        onRefresh={() => void onRefresh?.()}
        onFlash={(message) => onFlash?.(message)}
      />
    </div>
  );
}

export default ConnectionsSection;
