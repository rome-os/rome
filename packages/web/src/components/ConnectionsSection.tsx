import { AppDocumentAccess } from "@/components/connections/app-document-access";
import { Measure, Section } from "@rome-os/ui/page";
import { ListCollection } from "@rome-os/ui/layout-list";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Plus, RefreshCw, Search, Unplug, X } from "lucide-react";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import {
  ComposioServicePane,
  ComposioServiceRowButton,
  ComposioSignInBanner,
  useComposioConnect,
  useComposioServices,
} from "@/components/connections/composio-services";
import { ConnectionDetailPane } from "@/components/ConnectionDetail";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { slotCardCopy } from "@/lib/connection-capability-copy";
import {
  accountRoute,
  buildConnectionCards,
  isConnectedCard,
  type ConnectionCard,
} from "@/lib/connection-cards";
import { connectionStatus, StatusIndicator } from "@/lib/connection-status";
import { isImeCompositionEvent } from "@/lib/keyboard-submit";
import type { ComposioServiceRow } from "@/lib/composio-services";
import type { ApiConnection } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";

const TILE_GRID = "grid gap-2 sm:grid-cols-2";
/** One card in either grid: Connected and Add read as the same anatomy. */
const CARD = "h-auto w-full bg-surface py-2 text-left hover:bg-accent";

/**
 * The Connections tab: a search box, then two grids of the same cards,
 * Connected and Add.
 *
 * Connected lists every service that gives Rome access, Rome's own and
 * Composio's, attention first; each card shows its status and opens its
 * detail as a pane in place of the grids. Add lists the rest; each card opens
 * its connect ceremony, and a Composio service starts its authorization in a
 * new tab. Composio services need the Composio account first, so while it is
 * signed out the Add grid leads with its sign-in and those cards stay disabled.
 *
 * Search matches names in both lists, and also what an unconnected service
 * does, which its tile shows on hover and its detail states.
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

  // Which card's detail pane is open (null = closed). Track the route, not
  // the card object, so a refresh with the pane open re-derives the LIVE card.
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  // Mirrors `selectedRoute` for code that resumes after an await.
  const selectedRouteRef = useRef<string | null>(null);
  const select = (route: string | null) => {
    selectedRouteRef.current = route;
    setSelectedRoute(route);
  };
  const selected = cards.find((card) => card.route === selectedRoute) ?? null;

  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const describe = (card: ConnectionCard): string => {
    const slot = card.slots[0];
    const bullet = slot
      ? slotCardCopy(card.service, slot, slot.identity !== null).bullets[0]
      : null;
    return bullet ? t(bullet.key, bullet.params) : "";
  };
  const matches = (card: ConnectionCard, withDescription: boolean) =>
    !needle ||
    `${card.label} ${withDescription ? describe(card) : ""}`.toLocaleLowerCase().includes(needle);
  const needsAttention = (card: ConnectionCard) => connectionStatus(card).tone === "attention";

  // The services Rome reaches through Composio, from the Connector app.
  const composioInstalled = composio?.installed === true;
  const composioSignedIn = composioInstalled && composio?.loggedIn === true;
  const composioServices = useComposioServices({
    installed: composioInstalled,
    signedIn: composioSignedIn,
  });
  const { connect: connectComposio, busySlug } = useComposioConnect(onFlash);
  const [openService, setOpenService] = useState<string | null>(null);
  const matchesService = (row: ComposioServiceRow, withScope: boolean) =>
    !needle || `${row.name} ${withScope ? row.scope : ""}`.toLocaleLowerCase().includes(needle);

  const connectedCards = cards.filter(isConnectedCard);
  const connectedServices = composioServices.rows.connected;
  const shownConnected: (ConnectionCard | ComposioServiceRow)[] = [
    ...connectedCards.filter((card) => needsAttention(card) && matches(card, false)),
    ...connectedServices.filter((row) => row.needsAttention && matchesService(row, false)),
    ...connectedCards.filter((card) => !needsAttention(card) && matches(card, false)),
    ...connectedServices.filter((row) => !row.needsAttention && matchesService(row, false)),
  ];
  // Signed out, the Composio sign-in stands in for the Composio account tile.
  const shownAvailable = cards.filter(
    (card) => !isConnectedCard(card) && card.kind !== "composio" && matches(card, true),
  );
  const shownAvailableServices = composioServices.rows.available.filter((row) =>
    matchesService(row, true),
  );
  // The sign-in shows with the Composio services it unlocks, and on its own
  // for a search that names Composio.
  const composioCard = cards.find((card) => card.kind === "composio");
  const showComposioSignIn =
    composioInstalled &&
    !composioSignedIn &&
    (!needle ||
      shownAvailableServices.length > 0 ||
      (composioCard !== undefined && matches(composioCard, false)));
  const nothingMatches =
    needle !== "" &&
    !showComposioSignIn &&
    shownConnected.length === 0 &&
    shownAvailable.length === 0 &&
    shownAvailableServices.length === 0;

  const openRow = composioServices.rows.connected.find((row) => row.slug === openService) ?? null;
  const paneCard = selected ? selected.route : openRow ? `composio:${openRow.slug}` : null;

  // The open pane hides the grids, which drops the card's focus and scroll
  // position, so its card takes both back once the grids show again. The card
  // is looked up by id, since connecting from the pane moves it to Connected.
  const grids = useRef<HTMLDivElement>(null);
  const lastPaneCard = useRef<string | null>(null);
  useEffect(() => {
    const from = lastPaneCard.current;
    lastPaneCard.current = paneCard;
    if (paneCard !== null || from === null) return;
    const card = [...(grids.current?.querySelectorAll("[data-card]") ?? [])].find(
      (element) => element.getAttribute("data-card") === from,
    );
    card?.scrollIntoView?.({ block: "nearest" });
    card?.querySelector("button")?.focus({ preventScroll: true });
  }, [paneCard]);

  const cardSlot = (id: string, card: ReactNode) => (
    <div key={id} data-card={id} className="min-w-0">
      {card}
    </div>
  );

  const renderRow = (row: ConnectionCard | ComposioServiceRow) =>
    "route" in row
      ? cardSlot(
          row.route,
          <Button
            type="button"
            variant="outline"
            size="default"
            align="between"
            onClick={() => select(row.route)}
            className={CARD}
            aria-label={`Open ${row.label}`}
          >
            <span className="flex min-w-0 items-center gap-3">
              <ConnectionBrandBadge connection={row.service} />
              <span className="truncate text-ui text-foreground">{row.label}</span>
            </span>
            <StatusIndicator card={row} />
          </Button>,
        )
      : cardSlot(
          `composio:${row.slug}`,
          <ComposioServiceRowButton
            row={row}
            connected
            disabled={false}
            busy={false}
            onClick={() => setOpenService(row.slug)}
          />,
        );

  const renderTile = (card: ConnectionCard) =>
    cardSlot(
      card.route,
      <Button
        type="button"
        variant="outline"
        size="default"
        align="between"
        onClick={() => select(card.route)}
        title={describe(card) || undefined}
        className={CARD}
        aria-label={`Open ${card.label}`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <ConnectionBrandBadge connection={card.service} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-ui text-foreground">{card.label}</span>
            {/* A service the host cannot offer says so instead of offering a connect. */}
            {card.connect?.available === false ? <StatusIndicator card={card} /> : null}
          </span>
        </span>
        {card.connect?.available === false ? null : (
          <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </Button>,
    );

  const renderServiceTile = (row: ComposioServiceRow) =>
    cardSlot(
      `composio:${row.slug}`,
      <ComposioServiceRowButton
        row={row}
        connected={false}
        variant="tile"
        disabled={!composioSignedIn}
        busy={busySlug === row.slug}
        onClick={() => void connectComposio(row)}
      />,
    );

  // A freshly added account has no card until the list refetches, so refetch
  // first and point the pane at it only once its card exists. Otherwise the
  // pane would close, then reopen by itself when a later poll lists it.
  // A pane the guardian closed, or moved to another card, during the add
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
      {connections.some((connection) => connection.connectionKind === "feishu" && connection.id) ? (
        <AppDocumentAccess />
      ) : null}
      <Section>
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
          <div ref={grids} className="flex flex-col gap-5" hidden={paneCard !== null}>
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
            {composioInstalled && composioServices.error ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-8 border border-border px-4 py-3 text-ui text-muted-foreground">
                <span>{t("connections.composioServices.loadFailed")}</span>
                <Button type="button" variant="outline" size="sm" onClick={composioServices.retry}>
                  {t("page.retry")}
                </Button>
              </div>
            ) : null}
            {nothingMatches ? (
              <p className="rounded-8 border border-dashed border-border px-4 py-6 text-center text-ui text-muted-foreground">
                {t("connections.search.noMatch.all", { query: query.trim() })}
              </p>
            ) : null}
            {shownConnected.length > 0 ? (
              <section className="flex flex-col gap-2" aria-labelledby="connected-heading">
                <h3 id="connected-heading" className="text-aux text-muted-foreground">
                  {t("connections.sections.connected", {
                    count: connectedCards.length + connectedServices.length,
                  })}
                </h3>
                <ListCollection className={TILE_GRID}>
                  {shownConnected.map(renderRow)}
                </ListCollection>
              </section>
            ) : null}
            {shownAvailable.length > 0 ||
            shownAvailableServices.length > 0 ||
            showComposioSignIn ? (
              <section className="flex flex-col gap-2" aria-labelledby="add-heading">
                <h3 id="add-heading" className="text-aux text-muted-foreground">
                  {t("connections.sections.add")}
                </h3>
                {/* Composio services need the Composio account. Signed out, its
                  sign-in leads the tiles it unlocks, in a grid of their own;
                  signed in, every tile shares one grid. */}
                {showComposioSignIn ? (
                  <>
                    {shownAvailable.length > 0 ? (
                      <ListCollection className={TILE_GRID}>
                        {shownAvailable.map(renderTile)}
                      </ListCollection>
                    ) : null}
                    <ComposioSignInBanner onSignIn={() => select("composio")} />
                    {shownAvailableServices.length > 0 ? (
                      <ListCollection className={TILE_GRID}>
                        {shownAvailableServices.map(renderServiceTile)}
                      </ListCollection>
                    ) : null}
                  </>
                ) : (
                  <ListCollection className={TILE_GRID}>
                    {shownAvailable.map(renderTile)}
                    {shownAvailableServices.map(renderServiceTile)}
                  </ListCollection>
                )}
              </section>
            ) : null}
          </div>
        )}

        {/* Keyed by service, so each opens fresh, never mid-confirmation. */}
        <ComposioServicePane
          key={openService ?? "none"}
          row={openRow}
          busy={busySlug !== null}
          onReconnect={(row) => void connectComposio(row)}
          onClose={() => setOpenService(null)}
          onFlash={onFlash}
        />
        {selected ? (
          <ConnectionDetailPane
            card={selected}
            backLabel={t("tabs.Connections")}
            composio={composio}
            onClose={() => select(null)}
            // In the background: a foreground refresh swaps the grids for a
            // loading skeleton, which would show above the pane.
            onRefresh={() => void onRefresh(true)}
            onFlash={onFlash}
            onOpenAccount={openAccount}
          />
        ) : null}
      </Section>
    </Measure>
  );
}
