import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cross2Icon, DownloadIcon } from "@radix-ui/react-icons";
import type {
  TraceBlockDto,
  TraceSegment,
  TraceSnapshot,
  TraceSummary,
} from "@rome/api-types/trace-segments";
import { Button } from "@/components/ui/button";
import { CollapsedTraceSummary } from "./CollapsedTraceSummary";
import { TraceBody } from "./AgentTrace";
import { isTraceScrollNearBottom } from "./scroll-follow";
import { turnApiPath } from "./turn-api";
import { TraceUsageOptionsContext } from "@/components/chat/blocks/UsageSummaryBlock";

export type TraceDrawerTarget =
  | {
      kind: "stored";
      messageId: string;
      sessionId: string;
      turnId: string | null;
      summary: TraceSummary;
    }
  | {
      kind: "live";
      sessionId: string;
      turnId: string;
      summary: TraceSummary;
      segments: TraceSegment[];
      streaming: boolean;
    }
  | {
      kind: "turn";
      sessionId: string;
      turnId: string;
      summary: TraceSummary;
      dumpHref?: string;
    };

export function traceDrawerOpenPlacementClass(hasApps: boolean): string {
  if (hasApps) {
    // A widget already owns the surface beside chat. Keep it visible and cover
    // the actual desktop chat column, regardless of how wide that column may
    // become. Mobile keeps the base full-chat overlay below its header.
    return "fixed bottom-0 left-0 right-0 top-[var(--rome-mobile-header-height)] z-30 md:bottom-3 md:left-[var(--rome-chat-left,0px)] md:right-auto md:top-3 md:w-[var(--rome-chat-col)] md:rounded-12";
  }

  // With no widgets, width alone chooses the presentation: a narrow chat is
  // covered from its real left edge through the viewport's right edge, while a
  // wide chat keeps 480px for a docked inspector.
  // The desktop insets match the pane's gutter, so a drawer docked beside the
  // chat sits inside the same frame rather than covering the canvas around it.
  return "fixed bottom-0 left-0 right-0 top-[var(--rome-mobile-header-height)] z-30 @max-5xl/chat:md:bottom-3 @max-5xl/chat:md:left-[var(--rome-chat-left,0px)] @max-5xl/chat:md:right-3 @max-5xl/chat:md:top-3 @max-5xl/chat:md:w-auto @max-5xl/chat:md:rounded-12 @5xl/chat:bottom-3 @5xl/chat:left-auto @5xl/chat:right-3 @5xl/chat:top-3 @5xl/chat:w-[480px] @5xl/chat:rounded-12 @5xl/chat:border @5xl/chat:border-border";
}

export function traceDrawerContentInsetClass(open: boolean, hasApps: boolean): string {
  if (hasApps) return "";
  return open
    ? "@5xl/chat:flex-none @5xl/chat:w-[calc(100%-480px)]"
    : "@5xl/chat:flex-none @5xl/chat:w-full";
}

// Default stored-trace loader: lazy-fetch the guardian content endpoint. The
// public share page injects an in-memory resolver instead (no network, no auth).
async function fetchStoredTrace(
  messageId: string,
  includeSubagentUsage: boolean,
): Promise<TraceSnapshot | null> {
  const params = new URLSearchParams({ includeSubagentUsage: String(includeSubagentUsage) });
  const res = await fetch(`/api/chat/messages/${encodeURIComponent(messageId)}/content?${params}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { trace: TraceSnapshot | null };
  return data.trace;
}

async function fetchTurnTrace(
  sessionId: string,
  turnId: string,
  includeSubagentUsage: boolean,
): Promise<TraceSnapshot | null> {
  const params = new URLSearchParams({ includeSubagentUsage: String(includeSubagentUsage) });
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/trace?${params}`,
    { credentials: "include" },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { trace: TraceSnapshot | null };
  return data.trace;
}

export function TraceDrawer({
  target,
  onClose,
  renderInlineBlock,
  renderRunBlocks,
  loadStoredTrace = fetchStoredTrace,
  loadTurnTrace = fetchTurnTrace,
  allowSubagentUsage = true,
  readOnly = false,
  hasApps = false,
}: {
  target: TraceDrawerTarget | null;
  onClose: () => void;
  renderInlineBlock: (block: TraceBlockDto, key: string) => React.ReactNode;
  renderRunBlocks: (blocks: TraceBlockDto[], live: boolean) => React.ReactNode;
  // Resolve a stored trace's segments. Defaults to the authed content endpoint;
  // the share page passes a map-backed resolver so traces render from the frozen
  // snapshot. A thrown error surfaces as the drawer's retryable error state.
  loadStoredTrace?: (
    messageId: string,
    includeSubagentUsage: boolean,
  ) => Promise<TraceSnapshot | null>;
  loadTurnTrace?: (
    sessionId: string,
    turnId: string,
    includeSubagentUsage: boolean,
  ) => Promise<TraceSnapshot | null>;
  /** Whether this surface can ask the backend for derived descendant usage. */
  allowSubagentUsage?: boolean;
  // Read-only surface (public share): hides the raw-dump download, which hits
  // a guardian-only endpoint.
  readOnly?: boolean;
  // App/widget presence is independent from chat width. When true, the trace
  // always covers the chat column so it never competes with the app surface.
  hasApps?: boolean;
}) {
  const { t } = useTranslation("activity");
  const [remoteTrace, setRemoteTrace] = useState<TraceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const loadedKeyRef = useRef<string | null>(null);
  const loadedTargetKeyRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldFollowLiveTraceRef = useRef(true);

  const storedId = target?.kind === "stored" ? target.messageId : null;
  const turnTarget = target?.kind === "turn" ? target : null;
  const remoteTargetKey = storedId
    ? `stored:${storedId}`
    : turnTarget
      ? `turn:${turnTarget.sessionId}:${turnTarget.turnId}`
      : null;
  const [usageOption, setUsageOption] = useState<{
    targetKey: string | null;
    include: boolean;
  }>({ targetKey: null, include: true });
  const includeSubagentUsage =
    usageOption.targetKey === remoteTargetKey ? usageOption.include : true;
  const liveTargetKey = target?.kind === "live" ? `${target.sessionId}:${target.turnId}` : null;

  useEffect(() => {
    if (!remoteTargetKey) {
      setRemoteTrace(null);
      setError(null);
      setLoading(false);
      setUsageOption({ targetKey: null, include: true });
      loadedKeyRef.current = null;
      loadedTargetKeyRef.current = null;
      return;
    }
    const key = `${remoteTargetKey}:${includeSubagentUsage}:${retryNonce}`;
    if (loadedKeyRef.current === key) return;
    let cancelled = false;
    loadedKeyRef.current = key;
    if (loadedTargetKeyRef.current !== remoteTargetKey) setRemoteTrace(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const trace = storedId
          ? await loadStoredTrace(storedId, includeSubagentUsage)
          : turnTarget
            ? await loadTurnTrace(turnTarget.sessionId, turnTarget.turnId, includeSubagentUsage)
            : null;
        if (cancelled) return;
        if (!trace) {
          setError(t("trace.drawer.notAvailable"));
          return;
        }
        loadedTargetKeyRef.current = remoteTargetKey;
        setRemoteTrace(trace);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? t("trace.drawer.loadFailedReason", { reason: err.message })
            : t("trace.drawer.loadFailed"),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    remoteTargetKey,
    storedId,
    turnTarget,
    includeSubagentUsage,
    retryNonce,
    t,
    loadStoredTrace,
    loadTurnTrace,
  ]);

  const onRetry = remoteTargetKey ? () => setRetryNonce((n) => n + 1) : undefined;

  const open = target !== null;
  const segments = target?.kind === "live" ? target.segments : (remoteTrace?.segments ?? null);
  const displaySummary = remoteTrace?.summary ?? target?.summary;
  const streaming = target?.kind === "live" && target.streaming;
  useLayoutEffect(() => {
    shouldFollowLiveTraceRef.current = true;
    if (target?.kind !== "live") return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [liveTargetKey, target?.kind]);

  const updateLiveTraceFollowState = useCallback(() => {
    if (target?.kind !== "live") return;
    const container = scrollContainerRef.current;
    if (!container) return;
    shouldFollowLiveTraceRef.current = isTraceScrollNearBottom(
      container.scrollHeight,
      container.scrollTop,
      container.clientHeight,
    );
  }, [target?.kind]);

  useLayoutEffect(() => {
    if (target?.kind !== "live" || !streaming || !shouldFollowLiveTraceRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [target, streaming]);

  const dumpHref = !readOnly
    ? target?.kind === "turn" && target.dumpHref
      ? target.dumpHref
      : target?.turnId
        ? turnApiPath(target.sessionId, target.turnId, "trace.json")
        : null
    : null;

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      const id = requestAnimationFrame(() => closeBtnRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger && document.contains(trigger) && typeof trigger.focus === "function") {
      trigger.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const canIncludeSubagentUsage =
    allowSubagentUsage && !!remoteTargetKey && !!target?.summary.subagents?.length;
  const usageOptions = {
    enabled: canIncludeSubagentUsage,
    includeSubagentUsage,
    loading,
    onIncludeSubagentUsageChange: (include: boolean) =>
      setUsageOption({ targetKey: remoteTargetKey, include }),
  };

  return (
    <TraceUsageOptionsContext.Provider value={usageOptions}>
      <aside
        role="dialog"
        aria-label={t("trace.drawer.ariaLabel")}
        aria-hidden={!open}
        inert={!open}
        data-layout={hasApps ? "chat-overlay" : "responsive"}
        // Only the desktop, no-app side panel animates. App presence and chat
        // width are separate inputs: apps always overlay; without apps the chat
        // container's 64rem breakpoint chooses overlay versus side panel.
        // Closed is a position state, not a zero-width box: the panel keeps
        // its 480px region measure and sits fully offscreen right
        // (`translate-x-full`), aria-hidden and inert. The transform
        // transition shares the chat column's 200ms width transition, so on
        // desktop the drawer's left edge rides the chat column's right edge
        // exactly as the old width animation did.
        className={`flex flex-col overflow-hidden bg-surface-elevated shadow-10 ${
          !hasApps ? "@5xl/chat:transition-transform @5xl/chat:duration-200 @5xl/chat:ease-out" : ""
        } ${
          open
            ? `translate-x-0 ${traceDrawerOpenPlacementClass(hasApps)}`
            : "fixed inset-y-0 right-0 w-[480px] translate-x-full"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-3">
          <h3 className="text-ui text-foreground">{t("trace.drawer.title")}</h3>
          {streaming && (
            <span className="inline-flex items-center gap-1 rounded-full bg-info-bg px-2 py-1 text-badge text-info-fg">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
              {t("trace.drawer.live")}
            </span>
          )}
          <div className="ml-2 min-w-0 flex-1">
            {displaySummary ? <CollapsedTraceSummary summary={displaySummary} /> : null}
          </div>
          {dumpHref && (
            <a
              href={dumpHref}
              download
              className="inline-flex items-center justify-center rounded-8 px-2 py-1 text-muted-foreground hover:bg-surface-muted hover:text-foreground"
              aria-label={t("trace.drawer.dumpAriaLabel")}
              title={t("trace.drawer.dumpTitle")}
            >
              <DownloadIcon className="h-4 w-4" />
            </a>
          )}
          <Button
            ref={closeBtnRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="text-muted-foreground"
            aria-label={t("trace.drawer.closeAriaLabel")}
          >
            <Cross2Icon className="h-4 w-4" />
          </Button>
        </div>
        <div
          ref={scrollContainerRef}
          onScroll={updateLiveTraceFollowState}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(0.75rem+var(--rome-safe-area-bottom))] pt-3"
        >
          {target ? (
            <TraceBody
              segments={segments}
              loading={loading}
              error={error}
              onRetry={onRetry}
              renderInlineBlock={renderInlineBlock}
              renderRunBlocks={renderRunBlocks}
              live={streaming}
            />
          ) : null}
        </div>
      </aside>
    </TraceUsageOptionsContext.Provider>
  );
}
