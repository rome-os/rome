import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
} from "@rome-os/node-ui";
import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { Badge } from "@rome-os/ui/badge";
import { Button } from "@rome-os/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rome-os/ui/dropdown-menu";
import { IconButton } from "@rome-os/ui/icon-button";
import { Download, Ellipsis, FolderOpen, ShieldCheck } from "lucide-react";
import {
  auditApi,
  type AuditItem,
  type AuditQuery,
  type AuditSummary,
  type AuditVerifyResult,
  type ContentName,
} from "@/lib/audit-api";
import { errorMessage } from "@/lib/rome-api";

const PAGE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const m = messagesFor("en");
const bytes = byteFormat("en");

/** What each reason means for the user, and what to do about it. */
const UNAVAILABLE: Record<string, { title: string; next: string }> = {
  sqlite_missing: {
    title: "This build of Rome cannot write an audit log.",
    next: "Install the latest Rome from romeos.cc.",
  },
  newer_schema: {
    title: "The audit log was written by a newer version of Rome.",
    next: "Update Rome. The file is left exactly as it is.",
  },
  unreadable: {
    title: "The audit log file cannot be read.",
    next: "Quit Rome and move the file somewhere else to keep it. Rome never deletes it; a new log starts on the next launch.",
  },
  io: {
    title: "The audit log cannot be written.",
    next: "Check the disk space and the folder's permissions. Rome tries again when the next request arrives.",
  },
};

type Result = "all" | "running" | "succeeded" | "failed" | "no_result";

const args = (item: AuditItem) => (item.record.args ?? {}) as Record<string, unknown>;
const num = (value: unknown) => (typeof value === "number" ? value : null);
const str = (value: unknown) => (typeof value === "string" ? value : null);

/** An audit request in the shape the device pages list. */
function toRow(item: AuditItem): NodeActionRow {
  const end = item.end?.record ?? {};
  const a = args(item);
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
          // The caller's side of a copy; the audit log knows only this Mac's path.
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

function Content({ item, name }: { item: AuditItem; name: ContentName }) {
  const owner = name === "stdin" ? item : item.end;
  const info = owner?.record.content?.[name];
  const [preview, setPreview] = useState<{ size: number; preview: Uint8Array } | null>();
  useEffect(() => {
    if (!info || !owner || !auditApi) return;
    auditApi.content(owner.seq, name).then(setPreview, () => setPreview(null));
  }, [info, owner, name]);
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
            <Badge variant="warning">Truncated · kept {bytes(info.storedBytes)}</Badge>
          )}
        </span>
        {preview && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void auditApi?.saveContent(owner.seq, name)}
          >
            Save full content…
          </Button>
        )}
      </div>
      <p className="break-all font-mono text-aux text-muted-foreground">SHA-256 {info.sha256}</p>
      {preview === null ? (
        <p className="text-aux text-muted-foreground">Removed by the retention rule.</p>
      ) : preview ? (
        <pre className="max-h-64 overflow-auto rounded-8 bg-muted p-3 font-mono text-aux whitespace-pre-wrap break-all">
          {new TextDecoder().decode(preview.preview)}
          {preview.size > preview.preview.byteLength ? "\n… first 256 KiB shown" : ""}
        </pre>
      ) : null}
    </section>
  );
}

/** Everything the audit log holds about one request. */
function AuditDetail({ item, row }: { item: AuditItem; row: NodeActionRow }) {
  const end = item.end?.record ?? {};
  const a = args(item);
  const envKeys = Array.isArray(item.record.envKeys) ? item.record.envKeys.map(String) : null;
  const facts: [string, ReactNode][] = [
    [m.command.started, `${new Date(item.at).toLocaleDateString()} ${clock(item.at, "en")}`],
    [m.command.duration, num(end.durationMs) === null ? "—" : formatDuration(num(end.durationMs)!)],
  ];
  if (num(end.exitCode) !== null) facts.push([m.command.exit, String(end.exitCode)]);
  if (str(end.signal)) facts.push([m.command.signal, String(end.signal)]);
  if (str(end.errorCode)) facts.push([m.command.error, String(end.errorCode)]);
  if (item.action === "exec") facts.push([m.command.cwd, str(a.cwd) ?? "where Rome runs"]);
  if (num(end.pid) !== null) facts.push(["Process", String(end.pid)]);
  if (row.transfer) {
    facts.push(["Direction", row.transfer.direction], ["Path", row.transfer.remotePath]);
    if (num(end.bytes) !== null) facts.push(["Size", bytes(num(end.bytes)!)]);
    if (str(end.sha256)) facts.push(["SHA-256", String(end.sha256)]);
    if (end.replaced !== undefined)
      facts.push([
        "Replaced file",
        end.replaced && typeof end.replaced === "object"
          ? bytes(num((end.replaced as Record<string, unknown>).size) ?? 0)
          : "none",
      ]);
    if (num(end.ackedBytes) !== null) facts.push(["Acknowledged", bytes(num(end.ackedBytes)!)]);
  }
  if (item.action === "fs.list" && Array.isArray(end.entries))
    facts.push(["Entries", String(end.entries.length)]);
  facts.push(["Request ID", str(item.record.requestId) ?? "—"]);
  const pushedWithoutContent =
    row.transfer?.direction === "push" && item.end && !item.end.record.content?.file;
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 text-aux text-muted-foreground">
        <ResultMark row={row} m={m} />
        <span aria-hidden>·</span>
        <span className="truncate">This Mac</span>
      </p>
      <pre className="max-h-64 overflow-auto rounded-8 bg-muted p-3 font-mono text-aux whitespace-pre-wrap break-all">
        <span className="select-none text-muted-foreground">$ </span>
        <code>{commandText(row)}</code>
      </pre>
      {!item.end && (
        <p className="text-aux text-muted-foreground">
          No end record: Rome stopped while this ran, or it is still running.
        </p>
      )}
      {item.end?.outcome === "interrupted" && (
        <p className="text-aux text-muted-foreground">
          Interrupted: the connection was replaced while this ran, and no reply was sent.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {facts.map(([label, value]) => (
          <Fact key={label} label={label}>
            {value}
          </Fact>
        ))}
      </dl>
      <dl className="grid gap-3">
        <Fact label="From">
          <span className="inline-flex flex-wrap items-center gap-2">
            {str(item.record.from) ?? "—"}
            <Badge variant="warning" title="Reported by Rome Cloud. This Mac cannot verify it.">
              Unverified
            </Badge>
          </span>
        </Fact>
        {envKeys && (
          <Fact label="Environment">
            <details>
              <summary className="cursor-pointer">{envKeys.length} names, no values</summary>
              {envKeys.join(" ")}
            </details>
          </Fact>
        )}
      </dl>
      {pushedWithoutContent && (
        <p className="text-aux text-muted-foreground">
          Larger than 10 MiB, so only its size and SHA-256 are kept.
        </p>
      )}
      <Content item={item} name="stdin" />
      <Content item={item} name="stdout" />
      <Content item={item} name="stderr" />
      <Content item={item} name="file" />
    </div>
  );
}

export function AuditPage() {
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [failure, setFailure] = useState<Extract<AuditVerifyResult, { ok: false }> | null>(null);
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
  useEffect(() => {
    const timer = window.setTimeout(() => setText(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const usable = summary?.status.state === "ok";

  const query = useCallback(
    (beforeSeq?: number): AuditQuery => ({
      requestsOnly: true,
      limit: PAGE,
      ...(result === "all" || result === "running" ? {} : { result }),
      ...(bucket === null ? {} : { since: bucket, until: bucket + BUCKET_MS - 1 }),
      ...(text ? { text } : {}),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    }),
    [result, bucket, text],
  );

  const refresh = useCallback(async () => {
    if (!auditApi) return;
    const at = Date.now();
    setNow(at);
    try {
      const next = await auditApi.status();
      setSummary(next);
      if (next.status.state !== "ok") return;
      const since = windowStart(at);
      const [stats, total, page] = await Promise.all([
        auditApi.stats(since, since + DAY_MS, BUCKET_MS),
        auditApi.counts(),
        // Requests never stay "running" in the log, so that filter shows none.
        result === "running" ? Promise.resolve([]) : auditApi.list(query()),
      ]);
      setSeries(statsByPeer(stats).get(""));
      setCounts({ ...total, running: 0 });
      setItems(page);
      setHasMore(page.length === PAGE);
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [query, result]);

  const verify = useCallback(async (announce: boolean) => {
    if (!auditApi) return;
    try {
      const outcome = await auditApi.verify();
      setFailure(outcome.ok === false ? outcome : null);
      if (announce && outcome.ok) setNotice("Integrity check passed.");
    } catch (err) {
      setFailure({ ok: false, records: 0, seq: null, reason: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // The integrity check runs once the log opens, and again when it recovers. Passing shows nothing.
  useEffect(() => {
    if (usable) void verify(false);
  }, [usable, verify]);
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

  const rows = useMemo(() => items.map(toRow), [items]);
  if (!auditApi)
    return <p className="p-6 text-ui">The audit log is available only inside the Rome app.</p>;

  const status = summary?.status;
  const reason = status?.state === "unavailable" ? UNAVAILABLE[status.code] : null;
  const selected = items.find((item) => item.seq === selectedId) ?? null;

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Audit log actions" icon={<Ellipsis />} size="sm" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!usable} onSelect={() => void verify(true)}>
          <ShieldCheck className="size-4" aria-hidden />
          Verify integrity
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!usable}
          onSelect={() =>
            void auditApi
              ?.export()
              .then((path) => path && setNotice(`Exported to ${path}`))
              .catch((err) => setNotice(`Export failed: ${errorMessage(err)}`))
          }
        >
          <Download className="size-4" aria-hidden />
          Export…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void auditApi?.reveal()}>
          <FolderOpen className="size-4" aria-hidden />
          Show in Finder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const alerts = (
    <>
      {reason && status?.state === "unavailable" && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>
            {reason.title} Remote requests to this Mac are refused until it is fixed.
          </AlertTitle>
          <AlertDescription>
            <p>{reason.next}</p>
            <p className="mt-1 break-all font-mono text-aux">{status.message}</p>
          </AlertDescription>
        </Alert>
      )}
      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>
            The audit log failed its integrity check
            {failure.seq === null ? "" : ` at record ${failure.seq}`}.
          </AlertTitle>
          <AlertDescription>
            {failure.reason} Records may have been changed or removed outside Rome.
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

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-6">
      <NodeActivityView
        device={{
          id: "this-mac",
          name: "Audit log",
          platform: "macos",
          status: usable ? "connected" : "not_connected",
        }}
        title="Audit log"
        subtitle="This Mac"
        actions={menu}
        notice={alerts}
        hideActivity={status?.state === "unavailable"}
        locale="en"
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
        rows={rows}
        loading={loading}
        hasMore={hasMore}
        onLoadMore={() => {
          setLoading(true);
          void auditApi
            ?.list(query(items.at(-1)?.seq))
            .then((page) => {
              setItems((current) => [...current, ...page]);
              setHasMore(page.length === PAGE);
            })
            .finally(() => setLoading(false));
        }}
        selectedId={selectedId}
        selectedRow={selected ? toRow(selected) : null}
        onSelect={setSelectedId}
        renderDetail={(row) => (selected ? <AuditDetail item={selected} row={row} /> : null)}
      />
    </main>
  );
}
