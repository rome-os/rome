import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@rome-os/ui/button";
import { Check, Copy } from "lucide-react";
import { NodeActivityView, type NodeActivityViewProps } from "./activity-view.js";
import { byteFormat, clock, commandText, formatDuration, scriptOf, startOfDay } from "./format.js";
import { DeviceMenu } from "./device-manage.js";
import { messagesFor, type NodeUiMessages } from "./messages.js";
import { ResultMark, useNow } from "./parts.js";
import type { NodeActionResult, NodeActionRow } from "./protocol.js";
import { BUCKET_MS, statsByPeer, windowStart } from "./stats.js";
import type { NodeDevice, NodeDeviceManage, NodeThisDevice } from "./types.js";
import { useAction, useActions, useNodeSocket, useStats } from "./use-node-socket.js";

export { NodeActivityView, type NodeActivityViewProps };

export interface NodeDeviceActivityProps {
  /** WebSocket URL of a backend that forwards the daemon's observation methods unchanged. */
  url: string;
  device: NodeDevice;
  /** A back link to the devices overview, rendered above the device name. */
  nav?: ReactNode;
  /** BCP 47 tag for text, dates, and numbers. Chinese for `zh*`, English otherwise. */
  locale?: string;
  /** The action shown in detail. The host keeps it in the URL. */
  selected?: number | null;
  onSelect?: (id: number | null) => void;
  /** Rename, disconnect, and remove in the header menu. */
  manage?: NodeDeviceManage;
  /** Set when `device` is the computer the host page runs on. Its menu connects it. */
  thisDevice?: NodeThisDevice;
}

type ResultFilter = NodeActionResult | "all";

interface Context {
  m: NodeUiMessages;
  locale: string | undefined;
  bytes: (value: number) => string;
}

function CopyCommand({ text, m }: { text: string; m: NodeUiMessages }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? (
        <Check data-icon="inline-start" aria-hidden />
      ) : (
        <Copy data-icon="inline-start" aria-hidden />
      )}
      {copied ? m.command.copied : m.command.copy}
    </Button>
  );
}

/** Everything the log knows about one action. */
function CommandDetail({
  row,
  device,
  now,
  context: { m, locale, bytes },
}: {
  row: NodeActionRow;
  device: NodeDevice;
  now: number;
  context: Context;
}) {
  const script = scriptOf(row);
  const day = startOfDay(row.startedAt);
  const today = startOfDay(now);
  const facts: [string, ReactNode][] = [
    [
      m.command.started,
      `${
        day === today
          ? m.detail.today
          : new Date(row.startedAt).toLocaleDateString(locale, { month: "short", day: "numeric" })
      } ${clock(row.startedAt, locale)}`,
    ],
    [m.command.duration, formatDuration((row.endedAt ?? now) - row.startedAt)],
  ];
  if (row.exitCode !== null) facts.push([m.command.exit, String(row.exitCode)]);
  if (row.signal) facts.push([m.command.signal, row.signal]);
  if (row.errorCode) facts.push([m.command.error, row.errorCode]);
  if (row.endedAt !== null)
    facts.push([m.command.output, bytes(row.transfer?.bytes ?? row.stdoutBytes)]);
  if (row.stderrBytes) facts.push([m.command.errors, bytes(row.stderrBytes)]);
  if (script) facts.push([m.command.shell, script.shell]);
  facts.push([m.command.cwd, row.cwd ?? "—"]);
  if (row.action !== "exec") facts.push([m.command.action, `${row.action} · ${row.mode}`]);
  if (row.transfer?.sha256) facts.push(["SHA-256", row.transfer.sha256]);
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 text-aux text-muted-foreground">
        <ResultMark row={row} m={m} />
        <span aria-hidden>·</span>
        <span className="truncate">{device.name}</span>
      </p>
      <pre className="max-h-64 overflow-auto rounded-8 bg-muted p-3 font-mono text-aux whitespace-pre-wrap break-all">
        <span className="select-none text-muted-foreground">$ </span>
        <code>{commandText(row)}</code>
      </pre>
      <CopyCommand text={commandText(row)} m={m} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-aux text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono text-aux text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {row.truncated && <p className="text-aux text-muted-foreground">{m.command.truncated}</p>}
    </div>
  );
}

/**
 * One device's commands over the last 24 hours: the totals and the load chart, a result filter
 * with counts, search, the command list, and the selected command's detail, beside the list on
 * a wide container and in a sheet on a narrow one.
 * Needs `@rome-os/node-ui/styles.css` in the host's Tailwind build.
 */
export function NodeDeviceActivity({
  url,
  device,
  nav,
  locale,
  selected: selectedProp,
  onSelect,
  manage,
  thisDevice,
}: NodeDeviceActivityProps) {
  const m = messagesFor(locale);
  const bytes = useMemo(() => byteFormat(locale), [locale]);
  const context: Context = { m, locale, bytes };
  const socket = useNodeSocket(url);
  const now = useNow(socket.running.length ? 1000 : 30_000);
  const since = windowStart(now);
  const statsQuery = useMemo(
    () => ({ since, bucketMs: BUCKET_MS, peer: device.id }),
    [since, device.id],
  );
  const { stats, supported } = useStats(socket, statsQuery);
  const series = useMemo(
    () => (stats ? statsByPeer(stats).get(device.id.toLowerCase()) : undefined),
    [stats, device.id],
  );
  const [result, setResult] = useState<ResultFilter>("all");
  const [bucket, setBucket] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setText(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const [localSelected, setLocalSelected] = useState<number | null>(null);
  const selectedId = selectedProp === undefined ? localSelected : selectedProp;
  const select = (id: number | null) => {
    if (selectedProp === undefined) setLocalSelected(id);
    onSelect?.(id);
  };

  const filters = useMemo(
    () => ({
      peer: device.id,
      ...(result === "all" ? {} : { result }),
      since: bucket ?? since,
      ...(bucket === null ? {} : { until: bucket + BUCKET_MS }),
      ...(text ? { text } : {}),
    }),
    [device.id, result, bucket, since, text],
  );
  const list = useActions(socket, filters);
  const fetched = useAction(
    socket,
    selectedId !== null && !list.rows.some((row) => row.id === selectedId) ? selectedId : null,
    device.id,
  );
  const selectedRow = list.rows.find((row) => row.id === selectedId) ?? fetched;
  return (
    <NodeActivityView
      device={device}
      nav={nav}
      locale={locale}
      now={now}
      actions={
        manage || thisDevice ? (
          <DeviceMenu device={device} self={thisDevice} manage={manage} m={m} />
        ) : undefined
      }
      notice={
        socket.link !== "open" ? (
          <p role="status" className="text-ui text-muted-foreground">
            {m.link[socket.link]}
          </p>
        ) : null
      }
      series={series}
      statsUnavailable={!supported}
      result={result}
      onResult={setResult}
      bucket={bucket}
      onBucket={setBucket}
      search={search}
      onSearch={setSearch}
      searching={Boolean(text)}
      rows={list.rows}
      loading={list.loading}
      hasMore={list.hasMore}
      onLoadMore={list.loadMore}
      selectedId={selectedId}
      selectedRow={selectedRow ?? null}
      onSelect={select}
      renderDetail={(row) => (
        <CommandDetail row={row} device={device} now={now} context={context} />
      )}
    />
  );
}
