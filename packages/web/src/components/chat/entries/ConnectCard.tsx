import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ConciergeConnectEntry } from "@rome/api-types/concierge";
import { Spinner } from "@rome-os/ui/spinner";
import { ConnectorIcon } from "@/components/brand-icons/connector-icon";
import { Button } from "@/components/ui/button";
import {
  isServiceWorking,
  notifyServiceConnected,
  openPendingTab,
  readConnector,
  SETTINGS_CONNECTIONS_PATH,
  startConnect,
  waitForService,
} from "@/lib/connect-card";

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  /** The browser would not open a tab, so nothing was started. */
  | { kind: "blocked" }
  | { kind: "failed"; reason: string | null };

/**
 * A card the Concierge shows to connect a service: its name and one button that
 * starts the connection. The entry saved in the card only draws it: a click
 * reads the connector list again and acts on the service's entry as it is then,
 * since the saved one may be stale (a sign-in done since must not be undone by
 * a second one). The card then watches that list, shows Connected when the
 * service works, and tells the Concierge in `chatId` so it goes on without the
 * guardian typing. A service that works when the card opens shows Connected and
 * tells nobody, since an old card in the history must not wake the Concierge
 * again. When the browser blocks the tab the flow needs, nothing is started and
 * the card points to Settings.
 */
export function ConnectCard({
  service,
  label,
  icon,
  connect,
  chatId,
}: {
  service: string;
  label: string;
  icon?: string | null;
  connect: ConciergeConnectEntry;
  chatId: string;
}) {
  const { t } = useTranslation("chat");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const run = useRef<AbortController | null>(null);
  const told = useRef(false);

  useEffect(() => {
    let current = true;
    void isServiceWorking(service).then((working) => {
      if (current && working) setPhase({ kind: "connected" });
    });
    return () => {
      current = false;
      run.current?.abort();
    };
  }, [service]);

  const start = useCallback(async () => {
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    // Opened on the click, before any request, so the browser does not take it for a pop-up.
    const tab = openPendingTab();
    if (!tab) {
      setPhase({ kind: "blocked" });
      return;
    }
    setPhase({ kind: "connecting" });
    const connectedNow = () => {
      setPhase({ kind: "connected" });
      if (chatId && !told.current) {
        told.current = true;
        void notifyServiceConnected(chatId, service);
      }
    };
    try {
      const fresh = await readConnector(service);
      if (controller.signal.aborted) return;
      if (!fresh) {
        tab.close();
        setPhase({ kind: "failed", reason: t("concierge.connect.checkFailed") });
        return;
      }
      if (fresh.state === "working") {
        tab.close();
        connectedNow();
        return;
      }
      const started = await startConnect(
        fresh.connect ?? { kind: "dashboard" },
        tab,
        controller.signal,
      );
      const connected =
        started.kind === "connected" || (await waitForService(service, controller.signal));
      if (controller.signal.aborted) return;
      if (!connected) {
        setPhase({ kind: "failed", reason: null });
        return;
      }
      connectedNow();
    } catch (err) {
      tab.close();
      if (controller.signal.aborted) return;
      setPhase({ kind: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }, [service, chatId, t]);

  const unavailable =
    connect.kind === "rome_oauth" && (!connect.available || !connect.url)
      ? (connect.unavailableReason ?? t("concierge.connect.unavailable"))
      : null;

  return (
    <div className="flex w-full max-w-md items-center gap-3 rounded-16 border border-border bg-surface px-3 py-2">
      <ConnectorIcon icon={icon} label={label} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-foreground">{label}</span>
        {unavailable ? (
          <span className="text-aux text-muted-foreground">{unavailable}</span>
        ) : phase.kind === "blocked" ? (
          <span className="text-aux text-destructive">{t("concierge.connect.blocked")}</span>
        ) : phase.kind === "failed" ? (
          <span className="text-aux text-destructive">
            {phase.reason ?? t("concierge.connect.notConnected")}
          </span>
        ) : null}
      </div>
      {phase.kind === "connected" ? (
        <span className="flex h-[var(--control-h-sm)] shrink-0 items-center gap-1 text-ui text-muted-foreground">
          <Check className="size-4" aria-hidden />
          {t("concierge.connect.connected")}
        </span>
      ) : unavailable || phase.kind === "blocked" ? (
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link to={SETTINGS_CONNECTIONS_PATH}>{t("concierge.connect.settings")}</Link>
        </Button>
      ) : phase.kind === "connecting" ? (
        <span className="flex h-[var(--control-h-sm)] shrink-0 items-center gap-2 text-ui text-muted-foreground">
          <Spinner size="sm" />
          {t("concierge.connect.connecting")}
        </span>
      ) : (
        <Button size="sm" className="shrink-0" onClick={() => void start()}>
          {phase.kind === "failed" ? t("concierge.connect.retry") : t("concierge.connect.action")}
        </Button>
      )}
    </div>
  );
}
