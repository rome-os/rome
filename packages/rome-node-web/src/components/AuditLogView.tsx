import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import {
  BUCKET_MS,
  NodeActivityView,
  ResultMark,
  byteFormat,
  clock,
  commandText,
  formatDuration,
  messagesFor,
  statsByPeer,
  windowStart,
  type DeviceStats,
  type NodeActionRow,
  type ResultCounts,
} from "@rome-os/node-ui/activity";
import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { Badge } from "@rome-os/ui/badge";
import { IconButton } from "@rome-os/ui/icon-button";
import { ApiError, api, type AuditItemsParams } from "../api";
import type { Locale, Messages } from "../i18n";
import type {
  AuditContentName,
  AuditContentPreviewResponse,
  AuditItem,
  AuditSummaryResponse,
  HostSnapshot,
} from "../types";

const PAGE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

type Result = "all" | "running" | "succeeded" | "failed" | "no_result";

export interface AuditLogViewProps {
  locale: Locale;
  t: Messages;
  snapshot: HostSnapshot;
  refreshSignal: number;
  onUnauthorized: () => void;
}

const argsOf = (item: AuditItem) => (item.record.args ?? {}) as Record<string, unknown>;
const num = (value: unknown) => (typeof value === "number" ? value : null);
const str = (value: unknown) => (typeof value === "string" ? value : null);

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function devicePlatformOf(platform: string): "macos" | "linux" | "windows" {
  const lower = platform.toLowerCase();
  if (lower.startsWith("darwin") || lower.startsWith("mac")) return "macos";
  if (lower.startsWith("win")) return "windows";
  return "linux";
}

/** Converts an audit request item into the row shape expected by NodeActivityView. */
function toRow(item: AuditItem): NodeActionRow {
  const end = item.end?.record ?? {};
  const a = argsOf(item);
  const content = { ...(item.record.content ?? {}), ...(item.end?.record.content ?? {}) };
  const transfer = item.action === "transfer.open";
  return {
    id: item.seq,
    direction: "in",
    peer: str(item.record.from),
    action: item.action ?? "",
    mode: transfer ? "copy" : item.record.transport === "binary" ? "binary" : "json",
    command: item.action === "exec" ? str(a.command) : null,
    args:
      item.action === "exec" && Array.isArray(a.args)
        ? a.args.map(String)
        : item.action === "fs.list"
          ? (str(a.path) ?? "~")
          : null,
    cwd: str(a.cwd),
    startedAt: item.at,
    // A request without an end record counts as "no result", like an interrupted one.
    endedAt: item.end?.at ?? item.at,
    outcome: !item.end
      ? "unknown_outcome"
      : item.end.outcome === "interrupted"
        ? "interrupted"
        : item.end.outcome === "error"
          ? "error"
          : "ok",
    errorCode: item.end ? str(end.errorCode) : "no end record",
    // A request that failed with an error code shows the code, even when its program exited 0.
    exitCode: item.end?.outcome === "error" ? null : num(end.exitCode),
    signal: str(end.signal),
    stdinBytes: content.stdin?.size ?? 0,
    stdoutBytes: content.stdout?.size ?? 0,
    stderrBytes: content.stderr?.size ?? 0,
    transfer: transfer
      ? {
          direction: a.direction === "pull" ? "pull" : "push",
          localPath: "Rome",
          remotePath: str(a.path) ?? "",
          bytes: num(end.bytes),
          sha256: str(end.sha256),
        }
      : null,
    ...(Object.values(content).some((info) => info && info.storedBytes < info.size)
      ? { truncated: true as const }
      : {}),
  };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-aux text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-aux text-foreground">{children}</dd>
    </div>
  );
}

function ContentPreview({
  item,
  name,
  locale,
  t,
  onUnauthorized,
}: {
  item: AuditItem;
  name: AuditContentName;
  locale: Locale;
  t: Messages;
  onUnauthorized: () => void;
}) {
  const owner = name === "stdin" ? item : item.end;
  const info = owner?.record.content?.[name];
  const hasContent = Boolean(info && owner);
  const contentSha = info?.sha256;
  const contentStoredBytes = info?.storedBytes;
  const bytes = useMemo(() => byteFormat(locale), [locale]);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; data: AuditContentPreviewResponse } | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    if (!hasContent) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    api
      .auditContent(item.seq, name, undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ kind: "ready", data });
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
          return;
        }
        setState({ kind: "error" });
      });
    return () => controller.abort();
  }, [hasContent, contentSha, contentStoredBytes, item.seq, name, onUnauthorized]);

  if (!info || !owner) return null;

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-ui font-medium text-foreground">
          {name}
          <span className="font-mono text-aux font-normal text-muted-foreground">
            {bytes(info.size)}
          </span>
          {info.storedBytes < info.size && (
            <Badge variant="warning">{t.log.detail.truncatedBadge(bytes(info.storedBytes))}</Badge>
          )}
        </span>
      </div>
      <p className="break-all font-mono text-aux text-muted-foreground">
        {t.log.detail.sha256} {info.sha256}
      </p>
      {state.kind === "loading" ? (
        <p className="text-aux text-muted-foreground">{t.log.detail.loadingPreview}</p>
      ) : state.kind === "error" ? (
        <p className="text-aux text-muted-foreground">{t.log.detail.contentLoadFailed}</p>
      ) : !state.data.available ? (
        <p className="text-aux text-muted-foreground">{t.log.detail.prunedNotice}</p>
      ) : state.data.isBinary ? (
        <p className="text-aux text-muted-foreground">
          {t.log.detail.binaryNotice(bytes(state.data.size))}
        </p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-8 bg-muted p-3 font-mono text-aux whitespace-pre-wrap break-all">
          {state.data.text ?? ""}
          {state.data.truncated
            ? t.log.detail.truncatedPreview(bytes(state.data.previewBytes))
            : ""}
        </pre>
      )}
    </section>
  );
}

/** Everything the audit log holds about one request. */
function AuditDetail({
  item,
  row,
  deviceLabel,
  locale,
  t,
  onUnauthorized,
}: {
  item: AuditItem;
  row: NodeActionRow;
  deviceLabel: string;
  locale: Locale;
  t: Messages;
  onUnauthorized: () => void;
}) {
  const m = useMemo(() => messagesFor(locale), [locale]);
  const bytes = useMemo(() => byteFormat(locale), [locale]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [item.seq]);

  const end = item.end?.record ?? {};
  const a = argsOf(item);
  const envKeys = Array.isArray(item.record.envKeys) ? item.record.envKeys.map(String) : null;
  const cmd = commandText(row);

  const facts: [string, ReactNode][] = [
    [
      m.command.started,
      `${new Date(item.at).toLocaleDateString(locale)} ${clock(item.at, locale)}`,
    ],
    [m.command.duration, num(end.durationMs) === null ? "—" : formatDuration(num(end.durationMs)!)],
  ];
  if (num(end.exitCode) !== null) facts.push([m.command.exit, String(end.exitCode)]);
  if (str(end.signal)) facts.push([m.command.signal, String(end.signal)]);
  if (str(end.errorCode)) facts.push([m.command.error, String(end.errorCode)]);
  if (item.action === "exec") facts.push([m.command.cwd, str(a.cwd) ?? t.log.detail.defaultCwd]);
  if (num(end.pid) !== null) facts.push([t.log.detail.process, String(end.pid)]);
  if (row.transfer) {
    facts.push(
      [t.log.detail.direction, row.transfer.direction],
      [t.log.detail.path, row.transfer.remotePath],
    );
    if (num(end.bytes) !== null) facts.push([t.log.detail.size, bytes(num(end.bytes)!)]);
    if (str(end.sha256)) facts.push([t.log.detail.sha256, String(end.sha256)]);
    if (end.replaced !== undefined) {
      facts.push([
        t.log.detail.replacedFile,
        end.replaced && typeof end.replaced === "object"
          ? bytes(num((end.replaced as Record<string, unknown>).size) ?? 0)
          : t.log.detail.replacedNone,
      ]);
    }
    if (num(end.ackedBytes) !== null) {
      facts.push([t.log.detail.acknowledged, bytes(num(end.ackedBytes)!)]);
    }
  }
  if (item.action === "fs.list" && num(end.entriesCount) !== null) {
    facts.push([t.log.detail.entries, String(end.entriesCount)]);
  }
  facts.push([t.log.detail.requestId, str(item.record.requestId) ?? "—"]);

  const pushedWithoutContent =
    row.transfer?.direction === "push" && item.end && !item.end.record.content?.file;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API may be unavailable on non-secure origins.
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 text-aux text-muted-foreground">
        <ResultMark row={row} m={m} />
        <span aria-hidden>·</span>
        <span className="truncate">{deviceLabel}</span>
      </p>
      <div className="relative">
        <pre className="max-h-64 overflow-auto rounded-8 bg-muted p-3 pr-10 font-mono text-aux whitespace-pre-wrap break-all">
          <span className="select-none text-muted-foreground">$ </span>
          <code>{cmd}</code>
        </pre>
        <div className="absolute top-2 right-2">
          <IconButton
            label={copied ? m.command.copied : m.command.copy}
            size="xs"
            onClick={() => void handleCopy()}
            icon={copied ? <Check /> : <Copy />}
          />
        </div>
      </div>
      {item.record.recordTruncated && (
        <p className="text-aux text-muted-foreground">{t.log.detail.recordTruncatedNotice}</p>
      )}
      {!item.end && <p className="text-aux text-muted-foreground">{t.log.detail.noEndNotice}</p>}
      {item.end?.outcome === "interrupted" && (
        <p className="text-aux text-muted-foreground">{t.log.detail.interruptedNotice}</p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {facts.map(([label, value]) => (
          <Fact key={label} label={label}>
            {value}
          </Fact>
        ))}
      </dl>
      <dl className="grid gap-3">
        <Fact label={t.log.detail.from}>
          <span className="inline-flex flex-wrap items-center gap-2">
            {str(item.record.from) ?? "—"}
            <Badge variant="warning" title={t.log.detail.unverifiedTitle}>
              {t.log.detail.unverified}
            </Badge>
          </span>
        </Fact>
        {envKeys && (
          <Fact label={t.log.detail.environment}>
            <details>
              <summary className="cursor-pointer">
                {t.log.detail.envSummary(envKeys.length)}
              </summary>
              {envKeys.join(" ")}
            </details>
          </Fact>
        )}
      </dl>
      {pushedWithoutContent && (
        <p className="text-aux text-muted-foreground">{t.log.detail.largePushNotice}</p>
      )}
      <ContentPreview
        item={item}
        name="stdin"
        locale={locale}
        t={t}
        onUnauthorized={onUnauthorized}
      />
      <ContentPreview
        item={item}
        name="stdout"
        locale={locale}
        t={t}
        onUnauthorized={onUnauthorized}
      />
      <ContentPreview
        item={item}
        name="stderr"
        locale={locale}
        t={t}
        onUnauthorized={onUnauthorized}
      />
      <ContentPreview
        item={item}
        name="file"
        locale={locale}
        t={t}
        onUnauthorized={onUnauthorized}
      />
    </div>
  );
}

export function AuditLogView({
  locale,
  t,
  snapshot,
  refreshSignal,
  onUnauthorized,
}: AuditLogViewProps) {
  const bytes = useMemo(() => byteFormat(locale), [locale]);
  const [summary, setSummary] = useState<AuditSummaryResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [series, setSeries] = useState<DeviceStats>();
  const [counts, setCounts] = useState<ResultCounts>();
  const [items, setItems] = useState<AuditItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<Result>("all");
  const [bucket, setBucket] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<AuditItem | null>(null);

  const refreshAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === "") {
      setText("");
      return;
    }
    const timer = window.setTimeout(() => setText(trimmed), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const usable = summary?.status.state === "ok";

  const queryParams = useCallback(
    (beforeSeq?: number): AuditItemsParams => ({
      limit: PAGE,
      ...(result === "all" || result === "running" ? {} : { result }),
      ...(bucket === null ? {} : { since: bucket, until: bucket + BUCKET_MS - 1 }),
      ...(text ? { text } : {}),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    }),
    [result, bucket, text],
  );

  const refresh = useCallback(async () => {
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;

    const at = Date.now();
    setNow(at);
    try {
      const next = await api.auditSummary(controller.signal);
      if (controller.signal.aborted) return;
      setSummary(next);
      if (next.status.state !== "ok") {
        setSeries(undefined);
        setCounts(undefined);
        setItems([]);
        setHasMore(false);
        return;
      }
      const since = windowStart(at);
      const [stats, page] = await Promise.all([
        api.auditStats(since, since + DAY_MS, BUCKET_MS, controller.signal),
        // Requests never stay "running" in the audit log, so that filter shows none.
        result === "running"
          ? Promise.resolve({ items: [], hasMore: false })
          : api.auditItems(queryParams(), controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setSeries(statsByPeer(stats).get(""));
      setCounts(
        next.counts
          ? { ...next.counts, running: 0 }
          : { all: 0, running: 0, succeeded: 0, failed: 0, no_result: 0 },
      );
      setItems(page.items);
      setHasMore(page.hasMore);
      setNotice(null);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [queryParams, result, onUnauthorized]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshAbortRef.current?.abort();
    };
  }, [refresh, refreshSignal]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const listSelected = useMemo(
    () => items.find((item) => item.seq === selectedId) ?? null,
    [items, selectedId],
  );
  const selectedSeq = listSelected?.seq ?? null;
  const selectedTruncated = Boolean(listSelected?.record.recordTruncated);

  // If the selected list row had fields truncated at the 4 KiB list limit, fetch the full detail record.
  useEffect(() => {
    setExpandedDetail(null);
    if (selectedSeq === null || !selectedTruncated) return;
    const controller = new AbortController();
    api
      .auditItem(selectedSeq, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setExpandedDetail(res.item);
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
      });
    return () => controller.abort();
  }, [selectedSeq, selectedTruncated, onUnauthorized]);

  const selected =
    expandedDetail && expandedDetail.seq === selectedId ? expandedDetail : listSelected;
  const rows = useMemo(() => items.map(toRow), [items]);
  const selectedRow = useMemo(() => (selected ? toRow(selected) : null), [selected]);

  const status = summary?.status;
  const reason = status?.state === "unavailable" ? t.log.unavailable[status.code] : null;
  const deviceLabel = snapshot.deviceName || t.log.thisNode;

  const storageSummary =
    summary && usable ? (
      <span className="text-aux tabular-nums text-muted-foreground">
        {t.log.storageMeta(bytes(summary.bytes), summary.requests, summary.retention.maxAgeDays)}
      </span>
    ) : undefined;

  const alerts = (
    <>
      {reason && status?.state === "unavailable" && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>
            {reason.title} {t.log.unavailableSuffix}
          </AlertTitle>
          <AlertDescription>
            <p>{reason.next}</p>
            <p className="mt-1 break-all font-mono text-aux">{status.message}</p>
          </AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-ui text-muted-foreground">
          {notice}
        </p>
      )}
    </>
  );

  function handleLoadMore() {
    const oldest = items.at(-1)?.seq;
    if (oldest === undefined || loading) return;
    setLoading(true);
    void api
      .auditItems(queryParams(oldest))
      .then((page) => {
        setItems((current) => [...current, ...page.items]);
        setHasMore(page.hasMore);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
          return;
        }
        setNotice(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  return (
    <NodeActivityView
      device={{
        id: snapshot.deviceId ?? "this-node",
        name: t.log.title,
        platform: devicePlatformOf(snapshot.platform),
        status: usable ? "connected" : "not_connected",
      }}
      title={t.log.title}
      subtitle={deviceLabel}
      actions={storageSummary}
      notice={alerts}
      hideActivity={status?.state === "unavailable"}
      locale={locale}
      now={now}
      series={usable ? series : undefined}
      counts={usable ? counts : undefined}
      result={result}
      onResult={(value) => {
        setLoading(true);
        setResult(value);
      }}
      bucket={bucket}
      onBucket={setBucket}
      search={search}
      onSearch={setSearch}
      searching={Boolean(text)}
      minSearchLength={1}
      rows={rows}
      loading={loading}
      hasMore={hasMore}
      onLoadMore={handleLoadMore}
      selectedId={selectedId}
      selectedRow={selectedRow}
      onSelect={setSelectedId}
      renderDetail={(row) =>
        selected ? (
          <AuditDetail
            item={selected}
            row={row}
            deviceLabel={deviceLabel}
            locale={locale}
            t={t}
            onUnauthorized={onUnauthorized}
          />
        ) : null
      }
    />
  );
}
