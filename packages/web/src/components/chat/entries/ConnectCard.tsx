import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ConciergeConnectEntry } from "@rome/api-types/concierge";
import { Spinner } from "@rome-os/ui/spinner";
import { Button } from "@/components/ui/button";
import {
  isServiceWorking,
  notifyServiceConnected,
  openPendingTab,
  SETTINGS_CONNECTIONS_PATH,
  startConnect,
  waitForService,
} from "@/lib/connect-card";

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "failed"; reason: string | null };

/**
 * A card the Concierge shows to connect a service: its name and one button that
 * starts the connection from the entry the Concierge's connector list gave it.
 * The card then watches that list, shows Connected when the service works, and
 * tells the Concierge in `chatId` so it goes on without the guardian typing.
 * A service that works when the card opens shows Connected and tells nobody,
 * since an old card in the history must not wake the Concierge again.
 */
export function ConnectCard({
  service,
  label,
  connect,
  chatId,
}: {
  service: string;
  label: string;
  connect: ConciergeConnectEntry;
  chatId: string;
}) {
  const { t } = useTranslation("chat");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const run = useRef<AbortController | null>(null);

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
    setPhase({ kind: "connecting" });
    // Opened on the click, before any request, so the browser does not take it for a pop-up.
    const tab = openPendingTab();
    try {
      const started = await startConnect(connect, tab, controller.signal);
      const connected =
        started.kind === "connected" || (await waitForService(service, controller.signal));
      if (controller.signal.aborted) return;
      if (!connected) {
        setPhase({ kind: "failed", reason: null });
        return;
      }
      setPhase({ kind: "connected" });
      if (chatId) void notifyServiceConnected(chatId, service);
    } catch (err) {
      tab?.close();
      if (controller.signal.aborted) return;
      setPhase({ kind: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }, [connect, service, chatId]);

  const unavailable =
    connect.kind === "rome_oauth" && (!connect.available || !connect.url)
      ? (connect.unavailableReason ?? t("concierge.connect.unavailable"))
      : null;

  return (
    <div className="flex w-full max-w-md items-center gap-3 rounded-16 border border-border bg-surface px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-foreground">{label}</span>
        {unavailable ? (
          <span className="text-aux text-muted-foreground">{unavailable}</span>
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
      ) : unavailable ? (
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
