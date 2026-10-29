import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ComposioServiceBadge } from "@/components/brand-icons/composio-glyphs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@rome-os/ui/spinner";
import {
  COMPOSIO_ACCOUNTS_QUERY_KEY,
  COMPOSIO_CATALOG_QUERY_KEY,
  COMPOSIO_STATUS_QUERY_KEY,
  composioServiceRows,
  disconnectComposioService,
  fetchComposioAccounts,
  fetchComposioCatalog,
  fetchComposioWebhookStatus,
  registerComposioWebhook,
  startComposioConnect,
  type ComposioCatalogEntry,
  type ComposioServiceRow,
} from "@/lib/composio-services";
import { StatusIndicator, type ConnectionStatus } from "@/lib/connection-status";

/**
 * The Composio services as Settings › Connections rows. The catalog loads once
 * Composio is installed; the connected accounts only while signed in, since the
 * Connector API refuses to list them otherwise. Signed out, every catalog
 * service is available and none is connected.
 */
export function useComposioServices({
  installed,
  signedIn,
}: {
  installed: boolean;
  signedIn: boolean;
}) {
  const catalog = useQuery({
    queryKey: COMPOSIO_CATALOG_QUERY_KEY,
    queryFn: fetchComposioCatalog,
    enabled: installed,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const accounts = useQuery({
    queryKey: COMPOSIO_ACCOUNTS_QUERY_KEY,
    queryFn: fetchComposioAccounts,
    enabled: installed && signedIn,
    // A connection finished in another tab must show when the guardian comes
    // back, however soon, so focus always refetches.
    staleTime: 0,
  });
  // The catalog says which toolkits Rome manages, so no row shows before it
  // loads: an account read without it could be a bridged GitHub one. Signed
  // in, the accounts must load too, or a connected service would pass for an
  // available one.
  const rows =
    catalog.data && (!signedIn || accounts.data)
      ? composioServiceRows(catalog.data, signedIn ? (accounts.data ?? []) : [])
      : { connected: [], available: [] };
  useConnectReturnNotice(catalog.data, catalog.data !== undefined || catalog.isError);
  return {
    rows,
    error: catalog.error ?? (signedIn ? accounts.error : null),
    retry: () => {
      void catalog.refetch();
      if (signedIn) void accounts.refetch();
    },
  };
}

/**
 * The Connector's OAuth callback sends the authorize tab back here with
 * `?connector=<slug>&status=<status>`. Says whether the connect finished, once
 * the catalog can name the service, then drops just those params so a reload
 * does not say it again.
 */
function useConnectReturnNotice(catalog: ComposioCatalogEntry[] | undefined, settled: boolean) {
  const { t } = useTranslation("settings");
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const slug = params.get("connector");
  const status = params.get("status");
  useEffect(() => {
    if (!slug || !settled) return;
    const name = catalog?.find((entry) => entry.slug === slug.toLowerCase())?.name ?? slug;
    // One id per return, so a re-run of this effect cannot stack a second
    // toast. Only an active result reads as success: a declined or failed
    // round trip must not.
    const id = `composio-return-${slug}`;
    if ((status ?? "").toUpperCase() === "ACTIVE") {
      toast.success(t("connections.composioServices.returnConnected", { name }), { id });
      void client.invalidateQueries({ queryKey: COMPOSIO_ACCOUNTS_QUERY_KEY });
    } else {
      toast.error(t("connections.composioServices.returnFailed", { name }), { id });
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("connector");
        next.delete("status");
        return next;
      },
      { replace: true },
    );
  }, [slug, status, catalog, settled, client, setParams, t]);
}

function rowStatus(row: ComposioServiceRow): ConnectionStatus {
  return row.needsAttention
    ? {
        label: "Broken",
        tone: "attention",
        title: "The platform stopped accepting Rome's access. Reconnect it.",
      }
    : { label: "Working", tone: "success" };
}

/** Starts a Composio OAuth in a new tab, the way the Connector page does. */
export function useComposioConnect(onFlash: (message: string) => void) {
  const { t } = useTranslation("settings");
  const client = useQueryClient();
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const connect = async (row: ComposioServiceRow) => {
    setBusySlug(row.slug);
    try {
      const result = await startComposioConnect(row.slug);
      if (result.alreadyConnected) {
        await client.invalidateQueries({ queryKey: COMPOSIO_ACCOUNTS_QUERY_KEY });
        toast(t("connections.composioServices.alreadyConnected", { name: row.name }));
      } else if (result.authorizationUrl) {
        const url = result.authorizationUrl;
        window.open(url, "_blank", "noopener,noreferrer");
        // The tab opens after the request returns, which a strict popup blocker
        // (iOS Safari) can refuse, and `noopener` hides whether it did. The
        // action opens it again from a click of its own.
        toast(t("connections.composioServices.authorize", { name: row.name }), {
          action: {
            label: t("connections.composioServices.openTab"),
            onClick: () => window.open(url, "_blank", "noopener,noreferrer"),
          },
        });
      } else {
        onFlash(t("connections.composioServices.connectFailed"));
      }
    } catch (err) {
      onFlash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySlug(null);
    }
  };
  return { connect, busySlug };
}

export function ComposioServiceRowButton({
  row,
  connected,
  disabled,
  busy,
  onClick,
}: {
  row: ComposioServiceRow;
  connected: boolean;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <Button
      type="button"
      variant="outline"
      size="default"
      align="between"
      disabled={disabled || busy}
      onClick={onClick}
      className="h-auto w-full bg-surface py-3 text-left hover:bg-accent"
      aria-label={`${connected ? "Open" : "Connect"} ${row.name}`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <ComposioServiceBadge glyph={row.glyph} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="truncate text-ui text-foreground">{row.name}</span>
            {/* On Available the Via Composio heading already says so. */}
            {connected ? (
              <span className="text-aux text-muted-foreground">
                {t("connections.composioServices.via")}
              </span>
            ) : null}
          </span>
          {!connected && row.scope ? (
            <span className="truncate text-aux text-muted-foreground">{row.scope}</span>
          ) : null}
        </span>
      </span>
      {connected ? (
        <StatusIndicator status={rowStatus(row)} />
      ) : busy ? (
        <Spinner size="sm" label={t("common.connecting")} />
      ) : (
        <span className="shrink-0 text-ui text-primary">{t("connections.connect")}</span>
      )}
    </Button>
  );
}

/** Above the Composio group while signed out: every service there needs a
 *  Composio sign-in first. */
export function ComposioSignInBanner({ onSignIn }: { onSignIn: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-8 border border-border bg-surface-muted px-4 py-3 text-ui">
      <span>{t("connections.composioServices.signInBanner")}</span>
      <Button type="button" size="sm" onClick={onSignIn}>
        {t("connections.composioServices.signIn")}
      </Button>
    </div>
  );
}

/** A connected Composio service: what it lets Rome do, Reconnect when it is
 *  broken, and a confirmed Disconnect. */
export function ComposioServiceDialog({
  row,
  busy,
  onReconnect,
  onClose,
  onFlash,
}: {
  row: ComposioServiceRow | null;
  busy: boolean;
  onReconnect: (row: ComposioServiceRow) => void;
  onClose: () => void;
  onFlash: (message: string) => void;
}) {
  const { t } = useTranslation("settings");
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: (slug: string) => disconnectComposioService(slug),
    onSuccess: async (_, slug) => {
      await client.invalidateQueries({ queryKey: COMPOSIO_ACCOUNTS_QUERY_KEY });
      toast(t("connections.composioServices.disconnected", { name: row?.name ?? slug }));
      close();
    },
    onError: (err) => onFlash(err.message),
  });
  const close = () => {
    setConfirming(false);
    onClose();
  };

  return (
    <Dialog open={row !== null} onClose={close} size="md">
      {row && (
        <>
          <DialogHeader onClose={close}>
            <div className="flex items-center gap-3">
              <ComposioServiceBadge glyph={row.glyph} />
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-section">{row.name}</DialogTitle>
                <StatusIndicator status={rowStatus(row)} className="mt-1" />
              </div>
            </div>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <p className="text-ui text-muted-foreground">
                {t("connections.composioServices.viaLong")}
              </p>
              {row.scope ? (
                <div className="flex flex-col gap-1">
                  <p className="text-aux text-muted-foreground">
                    {t("connections.headings.connected")}
                  </p>
                  <p className="text-ui">{row.scope}</p>
                </div>
              ) : null}
              {confirming ? (
                <div className="flex flex-col gap-3 rounded-8 border border-border p-3">
                  <p className="text-ui">
                    {t("connections.composioServices.disconnectConfirm", { name: row.name })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
                      {t("common.cancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate(row.slug)}
                    >
                      {t("common.disconnect")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {/* A working service has nothing to reconnect: Composio would
                      answer that it is already connected. */}
                  {row.needsAttention ? (
                    <Button type="button" disabled={busy} onClick={() => onReconnect(row)}>
                      {t("connections.composioServices.reconnect")}
                    </Button>
                  ) : null}
                  <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
                    {t("common.disconnect")}
                  </Button>
                </div>
              )}
            </div>
          </DialogBody>
        </>
      )}
    </Dialog>
  );
}

/**
 * Whether connected services can deliver events (new email, new issue) to
 * Rome's routines. Signing in and connecting a service register the webhook
 * on their own; Set up again is the manual repair the Connector page offered.
 */
export function ComposioWebhookRow({ onFlash }: { onFlash: (message: string) => void }) {
  const { t } = useTranslation("settings");
  const client = useQueryClient();
  const status = useQuery({
    queryKey: COMPOSIO_STATUS_QUERY_KEY,
    queryFn: fetchComposioWebhookStatus,
  });
  const register = useMutation({
    mutationFn: registerComposioWebhook,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: COMPOSIO_STATUS_QUERY_KEY });
      toast(t("connections.composioServices.webhook.done"));
    },
    onError: (err) => onFlash(err.message),
  });
  if (!status.data) return null;
  const { relayConfigured, webhookRegistered } = status.data;
  const state = !relayConfigured ? "unavailable" : webhookRegistered ? "ready" : "notReady";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-8 border border-border px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-ui">{t("connections.composioServices.webhook.title")}</span>
        <StatusIndicator
          status={{
            label: t(`connections.composioServices.webhook.${state}`),
            tone: state === "ready" ? "success" : "attention",
          }}
        />
      </div>
      {relayConfigured ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={register.isPending}
          onClick={() => register.mutate()}
        >
          {t("connections.composioServices.webhook.setUp")}
        </Button>
      ) : null}
    </div>
  );
}
