import {
  Measure,
  Section,
  SectionHeader,
  SectionHeading,
  SectionTitle,
  SectionDescription,
} from "@rome-os/ui/page";
import { ListCollection } from "@rome-os/ui/layout-list";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, RefreshCw, Search, Unplug, X } from "lucide-react";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { AppKeysRow } from "@/components/connections/app-keys-row";
import { ConnectionDetailDialog } from "@/components/ConnectionDetail";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { slotCardCopy } from "@/lib/connection-capability-copy";
import {
  accountRoute,
  buildConnectionCards,
  groupConnectionCards,
  isConnectedCard,
  type ConnectionCard,
  type ConnectionTab,
} from "@/lib/connection-cards";
import { connectionStatus, StatusIndicator } from "@/lib/connection-status";
import { isImeCompositionEvent } from "@/lib/keyboard-submit";
import type { ApiConnection } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";

/**
 * Unified Connections list (list of rows).
 *
 * Renders every service the registry reports — Talk channels, OAuth services,
 * and the Composio broker account — over `GET /api/connections`, split into a
 * Connected and an Available tab with one search box over both, and grouped
 * into Messaging and Accounts. Each row is a full-width button: a connected
 * row shows the brand badge + label on the left and a dot+text
 * `StatusIndicator` on the right; an available row shows what the connection
 * does and a Connect cue. Clicking either opens the `ConnectionDetailDialog`
 * over the list, where the connect ceremony lives. The list itself performs NO
 * ceremony — no inline connect/disconnect, no expand-in-place cards, no
 * accordion.
 *
 * The Connected tab closes with the `AppKeysRow` — the app-keys vault is not a
 * registry service, but it lives on this surface, so it renders in the same
 * row anatomy and navigates to its own page. It self-loads and stays up
 * whatever state the registry request is in.
 */
export function ConnectionsSection({
  connections,
  composio,
  loading,
  error,
  onRefresh,
  onFlash,
}: {
  connections: ApiConnection[];
  composio: ComposioCliStatus | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch `/api/connections` + the Composio status, after a load error or a
   *  ceremony. Resolves to the fresh list, or null when the fetch failed. A
   *  background refresh keeps the list on screen while it loads. */
  onRefresh: (backgroundRefresh?: boolean) => Promise<ApiConnection[] | null>;
  onFlash: (message: string) => void;
}) {
  const { t } = useTranslation("settings");
  const cards = buildConnectionCards(connections, composio);

  // Which row's detail dialog is open (null = closed). Track the route, not
  // the card object, so a refresh mid-dialog re-derives the LIVE card.
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  // Mirrors `selectedRoute` for code that resumes after an await.
  const selectedRouteRef = useRef<string | null>(null);
  const select = (route: string | null) => {
    selectedRouteRef.current = route;
    setSelectedRoute(route);
  };
  const selected = cards.find((card) => card.route === selectedRoute) ?? null;

  // The page opens on Connected when anything is connected, otherwise on
  // Available. The choice is made once, when the list first loads, so a later
  // refresh never moves the guardian to the other tab.
  const [chosenTab, setChosenTab] = useState<ConnectionTab | null>(null);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const describe = (card: ConnectionCard): string => {
    const slot = card.slots[0];
    const bullet = slot
      ? slotCardCopy(card.service, slot, slot.identity !== null).bullets[0]
      : null;
    return bullet ? t(bullet.key, bullet.params) : "";
  };
  // Search matches what a row shows: the name, plus what the service does on
  // Available, the only tab that shows it.
  const matches = (card: ConnectionCard, withDescription: boolean) =>
    !needle ||
    `${card.label} ${withDescription ? describe(card) : ""}`.toLocaleLowerCase().includes(needle);
  const connected = cards.filter(isConnectedCard);
  const available = cards.filter((card) => !isConnectedCard(card));
  const shown: Record<ConnectionTab, ConnectionCard[]> = {
    connected: connected.filter((card) => matches(card, false)),
    available: available.filter((card) => matches(card, true)),
  };
  const tab: ConnectionTab = chosenTab ?? (connected.length > 0 ? "connected" : "available");
  if (chosenTab === null && !loading && !error && cards.length > 0) setChosenTab(tab);
  const otherTab: ConnectionTab = tab === "connected" ? "available" : "connected";
  const showAppKeys =
    tab === "connected" && (!needle || t("appKeys.title").toLocaleLowerCase().includes(needle));
  const needsAttention = (card: ConnectionCard) => connectionStatus(card).tone === "attention";

  // A freshly added account has no card until the list refetches, so refetch
  // first and point the dialog at it only once its card exists. Otherwise the
  // dialog would close, then reopen by itself when a later poll lists it.
  // A dialog the guardian closed, or moved to another card, during the add
  // stays where they left it.
  const openAccount = async (connectionId: string) => {
    const from = selectedRouteRef.current;
    const fresh = await onRefresh(true);
    const route = fresh && accountRoute(buildConnectionCards(fresh, composio), connectionId);
    if (!route) throw new Error(`Account ${connectionId} is not listed yet.`);
    if (from !== null && selectedRouteRef.current === from) select(route);
  };

  return (
    <Measure className="space-y-6">
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Connections</SectionTitle>
            <SectionDescription>
              Every account and tool your agent can use, in one place. Open one to connect it and
              see what it enables.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>

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
                onClick={() => void onRefresh()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden />
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
          <div className="flex flex-col gap-4">
            <div className="relative w-full">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground"
                aria-hidden
              />
              <Input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // Escape clears, but not mid-IME-composition, where it cancels
                  // the candidate buffer instead.
                  if (event.key === "Escape" && !isImeCompositionEvent(event)) setQuery("");
                }}
                placeholder={t("connections.search.placeholder")}
                aria-label={t("connections.search.placeholder")}
                className="h-9 pl-8 pr-8"
              />
              {query ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setQuery("")}
                  aria-label={t("connections.search.clear")}
                  title={t("connections.search.clear")}
                  className="absolute inset-y-0 right-2 my-auto text-subtle-foreground hover:bg-surface-muted hover:text-foreground dark:hover:bg-surface-muted"
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
            <SegmentedControl
              aria-label={t("connections.tabs.label")}
              value={tab}
              onValueChange={setChosenTab}
              className="self-start"
              options={(["connected", "available"] as const).map((value) => ({
                value,
                label: (
                  <span className="inline-flex items-center gap-2">
                    {t(`connections.tabs.${value}`)}
                    <span className="tabular-nums text-muted-foreground">
                      {shown[value].length}
                    </span>
                  </span>
                ),
              }))}
            />
            {/* A search that matches only App keys shows that row, not a
                no-match message above it. */}
            {shown[tab].length === 0 && !(needle && showAppKeys) ? (
              <div className="flex flex-col items-center gap-3 rounded-8 border border-dashed border-border px-4 py-6 text-center text-ui text-muted-foreground">
                <p>
                  {needle
                    ? t(`connections.search.noMatch.${tab}`, { query: query.trim() })
                    : t(`connections.tabs.empty.${tab}`)}
                </p>
                {shown[otherTab].length > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setChosenTab(otherTab)}
                  >
                    {t(`connections.tabs.show.${otherTab}`, { count: shown[otherTab].length })}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {groupConnectionCards(shown[tab], needsAttention).map(({ group, cards: rows }) => (
              <section
                key={group}
                className="flex flex-col gap-2"
                aria-labelledby={`${group}-heading`}
              >
                <h3 id={`${group}-heading`} className="text-aux text-muted-foreground">
                  {t(`connections.groups.${group}`)}
                </h3>
                <ListCollection className="flex flex-col gap-2">
                  {rows.map((card) => (
                    <Button
                      key={card.route}
                      type="button"
                      variant="outline"
                      size="default"
                      align="between"
                      onClick={() => select(card.route)}
                      className="h-auto w-full bg-surface py-3 text-left hover:bg-accent"
                      aria-label={`Open ${card.label}`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <ConnectionBrandBadge connection={card.service} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-ui text-foreground">{card.label}</span>
                          {tab === "available" && describe(card) ? (
                            <span className="truncate text-aux text-muted-foreground">
                              {describe(card)}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      {/* A service the host cannot offer keeps its Unavailable
                          status and reason instead of a Connect cue. */}
                      {tab === "connected" || card.connect?.available === false ? (
                        <StatusIndicator card={card} />
                      ) : (
                        <span className="shrink-0 text-ui text-primary">
                          {t("connections.connect")}
                        </span>
                      )}
                    </Button>
                  ))}
                </ListCollection>
              </section>
            ))}
            {showAppKeys ? (
              <section className="flex flex-col gap-2" aria-labelledby="other-heading">
                <h3 id="other-heading" className="text-aux text-muted-foreground">
                  {t("connections.groups.other")}
                </h3>
                <ListCollection className="flex flex-col gap-2">
                  <AppKeysRow />
                </ListCollection>
              </section>
            ) : null}
          </div>
        )}
        {loading || error || cards.length === 0 ? (
          <ListCollection className="mt-2 flex flex-col gap-2">
            <AppKeysRow />
          </ListCollection>
        ) : null}

        <ConnectionDetailDialog
          card={selected}
          composio={composio}
          onClose={() => select(null)}
          onRefresh={() => void onRefresh()}
          onFlash={onFlash}
          onOpenAccount={openAccount}
        />
      </Section>
    </Measure>
  );
}
