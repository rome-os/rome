import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@rome-os/ui/badge";
import { Button } from "@rome-os/ui/button";
import { Card, CardContent } from "@rome-os/ui/card";
import { cn } from "@rome-os/ui/cn";
import { Input } from "@rome-os/ui/input";
import { List, ListRow } from "@rome-os/ui/list-row";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rome-os/ui/select";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { format, messagesFor, type NodeConsoleMessages } from "./messages.js";
import type { NodeActionRow, NodeConnectionStatus, NodeOutcome } from "./protocol.js";
import { activeTextFilter, useNodeConsole, type NodeConsoleFilters } from "./use-node-console.js";

const ALL = "all";
const OUTCOME_FILTERS = ["ok", "error", "unknown_outcome", "interrupted", "aborted"] as const;

export interface NodeConsoleDevice {
  id: string;
  name: string;
}

export interface NodeConsoleProps {
  /**
   * WebSocket URL of a backend that forwards the daemon's observation methods unchanged, such as
   * Rome Core's `/ws/node`. A new value opens a new socket.
   */
  url: string;
  /** Names the history shows for device ids. Unknown ids show as the id. */
  devices?: NodeConsoleDevice[];
  /** BCP 47 tag for text, dates, and sizes. Chinese for `zh*`, English otherwise. */
  locale?: string;
}

/** Returns the shell and script of a `bash -lc` or `powershell -Command` exec, or null. */
export function scriptOf(row: NodeActionRow): { shell: string; script: string } | null {
  if (!row.command || !Array.isArray(row.args)) return null;
  const shell = (row.command.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  if (["bash", "sh", "zsh", "dash"].includes(shell)) {
    const flag = row.args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag >= 0 && row.args[flag + 1] !== undefined)
      return { shell, script: row.args[flag + 1]! };
  }
  if (shell === "powershell" || shell === "pwsh") {
    const flag = row.args.findIndex((arg) => /^-(command|c)$/i.test(arg));
    if (flag >= 0 && row.args[flag + 1] !== undefined)
      return { shell, script: row.args.slice(flag + 1).join(" ") };
  }
  return null;
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));

/** One line that names what the action did. */
export function summarize(row: NodeActionRow): string {
  if (row.transfer) {
    const { direction, localPath, remotePath } = row.transfer;
    return direction === "push" ? `${localPath} → ${remotePath}` : `${remotePath} → ${localPath}`;
  }
  const script = scriptOf(row);
  if (script) {
    // Scripts often open with setup lines such as `set -e`, so one line shows them all.
    const lines = script.script.split("\n").map((text) => text.trim());
    return `${script.shell}: ${lines.filter(Boolean).join("; ")}`;
  }
  if (row.command)
    return [row.command, ...(Array.isArray(row.args) ? row.args : [])].map(quote).join(" ");
  return `${row.action} ${typeof row.args === "string" ? row.args : ""}`.trim();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.floor(seconds % 60)} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function byteFormat(locale: string | undefined) {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  const formats = units.map(
    (unit) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }),
  );
  return (bytes: number) => {
    let value = bytes;
    let step = 0;
    while (value >= 1024 && step < units.length - 1) {
      value /= 1024;
      step++;
    }
    return formats[step]!.format(value);
  };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Shared by every row: the strings, the locale, and its formatters. */
interface Context {
  m: NodeConsoleMessages;
  locale: string | undefined;
  bytes: (value: number) => string;
}

function ConnectionStatus({ status, m }: { status: NodeConnectionStatus; m: NodeConsoleMessages }) {
  const tone =
    status === "online"
      ? "success"
      : ["retrying", "revoked", "superseded"].includes(status)
        ? "attention"
        : "muted";
  return (
    <span className="inline-flex items-center gap-2 text-ui text-muted-foreground">
      <span
        className={cn(
          "inline-block size-2 shrink-0 rounded-full",
          tone === "success"
            ? "bg-success"
            : tone === "attention"
              ? "bg-warning"
              : "border border-muted-foreground/40",
        )}
        aria-hidden
      />
      {tone === "attention" ? <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> : null}
      {m.connection[status]}
    </span>
  );
}

function OutcomeBadge({ row, m }: { row: NodeActionRow; m: NodeConsoleMessages }) {
  if (row.outcome === "ok" && row.exitCode !== null && row.exitCode !== 0)
    return <Badge variant="warning">{format(m.exitCode, { code: row.exitCode })}</Badge>;
  if (row.outcome === "ok" && row.signal) return <Badge variant="warning">{row.signal}</Badge>;
  const variant: Record<NodeOutcome, "success" | "destructive" | "warning" | "muted"> = {
    ok: "success",
    error: "destructive",
    unknown_outcome: "warning",
    interrupted: "muted",
    aborted: "muted",
  };
  if (!row.outcome) return <Badge variant="info">{m.outcome.running}</Badge>;
  return <Badge variant={variant[row.outcome]}>{m.outcome[row.outcome]}</Badge>;
}

function ActionDetails({
  row,
  deviceName,
  context: { m, locale, bytes },
}: {
  row: NodeActionRow;
  deviceName: string;
  context: Context;
}) {
  const script = scriptOf(row);
  const entries: [string, ReactNode][] = [
    [m.detail.device, `${deviceName} (${row.peer ?? "—"})`],
    [m.detail.action, `${row.action} · ${row.mode}`],
    [m.detail.started, new Date(row.startedAt).toLocaleString(locale)],
  ];
  if (row.endedAt !== null)
    entries.push([m.detail.duration, formatDuration(row.endedAt - row.startedAt)]);
  if (row.cwd) entries.push([m.detail.cwd, row.cwd]);
  if (row.errorCode) entries.push([m.detail.error, row.errorCode]);
  if (row.exitCode !== null) entries.push([m.detail.exit, String(row.exitCode)]);
  if (row.transfer?.sha256) entries.push(["SHA-256", row.transfer.sha256]);
  entries.push([
    m.detail.bytes,
    format(m.bytes, {
      stdin: bytes(row.stdinBytes),
      stdout: bytes(row.transfer?.bytes ?? row.stdoutBytes),
      stderr: bytes(row.stderrBytes),
    }),
  ]);
  return (
    <div className="space-y-3 pb-3">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-aux">
        {entries.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      {script ? (
        <pre className="max-h-80 overflow-auto rounded-8 bg-muted p-3 font-mono text-aux">
          <code>{script.script}</code>
        </pre>
      ) : row.command && Array.isArray(row.args) ? (
        <ol className="max-h-80 space-y-1 overflow-auto rounded-8 bg-muted p-3 font-mono text-aux">
          {[row.command, ...row.args].map((arg, index) => (
            <li key={index} className="break-all whitespace-pre-wrap">
              {arg}
            </li>
          ))}
        </ol>
      ) : typeof row.args === "string" ? (
        <pre className="max-h-80 overflow-auto rounded-8 bg-muted p-3 font-mono text-aux">
          <code>{row.args}</code>
        </pre>
      ) : null}
      {row.truncated && <p className="text-aux text-muted-foreground">{m.truncated}</p>}
    </div>
  );
}

function ActionItem({
  row,
  now,
  deviceName,
  context,
}: {
  row: NodeActionRow;
  now: number;
  deviceName: string;
  context: Context;
}) {
  const { m, locale, bytes } = context;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const duration = (row.endedAt ?? now) - row.startedAt;
  const output = row.transfer?.bytes ?? row.stdoutBytes;
  return (
    <li>
      <ListRow asChild interactive size="md">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-ui">{summarize(row)}</span>
            <span className="block truncate text-aux text-muted-foreground">
              {[
                format(row.direction === "in" ? m.from : m.to, { device: deviceName }),
                new Date(row.startedAt).toLocaleTimeString(locale),
                formatDuration(duration),
                output ? format(row.transfer ? m.copied : m.output, { size: bytes(output) }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <OutcomeBadge row={row} m={m} />
        </button>
      </ListRow>
      {open && (
        <div id={detailsId} className="px-[var(--row-px-md)]">
          <ActionDetails row={row} deviceName={deviceName} context={context} />
        </div>
      )}
    </li>
  );
}

/**
 * The activity of one rome-node daemon: its connection, the actions running now, and the
 * action history with search and filters. Renders cards only, so the host supplies the heading.
 * Needs `@rome-os/node-ui/styles.css` in the host's Tailwind build.
 */
export function NodeConsole({ url, devices = [], locale }: NodeConsoleProps) {
  const m = messagesFor(locale);
  const bytes = useMemo(() => byteFormat(locale), [locale]);
  const context: Context = { m, locale, bytes };
  const [peer, setPeer] = useState(ALL);
  const [outcome, setOutcome] = useState<string>(ALL);
  const [direction, setDirection] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setText(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const filters: NodeConsoleFilters = {
    ...(peer === ALL ? {} : { peer }),
    ...(outcome === ALL ? {} : { outcome: [outcome as NodeOutcome] }),
    ...(direction === ALL ? {} : { direction: direction as "in" | "out" }),
    ...(text ? { text } : {}),
  };
  const consoleState = useNodeConsole(url, filters);
  const { link, status, running, history, hasMore, loadingHistory } = consoleState;
  // Running actions show elapsed seconds. Otherwise only the connection age moves.
  const now = useNow(running.length > 0 ? 1000 : 30_000);
  const names = new Map(devices.map((device) => [device.id.toLowerCase(), device.name]));
  const nameOf = (row: NodeActionRow) =>
    (row.peer && names.get(row.peer.toLowerCase())) ?? row.peer ?? "—";
  const caller = status?.roles.caller;
  const host = status?.roles.host;
  const searchShort = search.trim().length > 0 && !activeTextFilter(search);
  const uid = useId();

  if (link !== "open")
    return (
      <Card>
        <CardContent>
          <p role="status" className="text-ui text-muted-foreground">
            {m.link[link]}
          </p>
        </CardContent>
      </Card>
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="text-ui">{m.callerLabel}</p>
              {caller ? (
                <ConnectionStatus status={caller.connection} m={m} />
              ) : (
                <p className="text-ui text-muted-foreground">—</p>
              )}
            </div>
            {caller && (
              <dl className="grid grid-cols-3 gap-4 text-ui sm:text-right">
                <div>
                  <dt className="text-aux text-muted-foreground">{m.since}</dt>
                  <dd>{formatDuration(now - caller.since)}</dd>
                </div>
                <div>
                  <dt className="text-aux text-muted-foreground">{m.reconnects}</dt>
                  <dd>{caller.reconnects}</dd>
                </div>
                <div>
                  <dt className="text-aux text-muted-foreground">{m.runningCount}</dt>
                  <dd>{running.length}</dd>
                </div>
              </dl>
            )}
          </div>
          {status && (
            <p className="text-aux text-muted-foreground">
              {format(m.service, {
                version: status.version,
                time: new Date(status.startedAt).toLocaleString(locale),
              })}
            </p>
          )}
        </CardContent>
      </Card>

      {running.length > 0 && (
        <Card>
          <CardContent className="space-y-2">
            <p className="text-ui">{m.running}</p>
            <List asChild>
              <ul aria-label={m.running}>
                {running.map((row) => (
                  <ActionItem
                    key={row.id}
                    row={row}
                    now={now}
                    deviceName={nameOf(row)}
                    context={context}
                  />
                ))}
              </ul>
            </List>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4">
          <p className="text-ui">{m.history}</p>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-48 flex-1"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={m.searchPlaceholder}
              aria-label={m.search}
              aria-describedby={searchShort ? `${uid}-search-hint` : undefined}
            />
            <Select value={peer} onValueChange={setPeer}>
              <SelectTrigger className="w-auto min-w-36" aria-label={m.device}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={ALL}>{m.allDevices}</SelectItem>
                {devices.map((device) => (
                  <SelectItem key={device.id} value={device.id.toLowerCase()}>
                    {device.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger className="w-auto min-w-36" aria-label={m.outcomeFilter}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={ALL}>{m.allOutcomes}</SelectItem>
                {OUTCOME_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {m.outcome[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {host && (
              <Select value={direction} onValueChange={setDirection}>
                <SelectTrigger className="w-auto min-w-36" aria-label={m.direction}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectItem value={ALL}>{m.allDirections}</SelectItem>
                  <SelectItem value="out">{m.sent}</SelectItem>
                  <SelectItem value="in">{m.received}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
          {searchShort && (
            <p id={`${uid}-search-hint`} className="text-aux text-muted-foreground">
              {m.searchHint}
            </p>
          )}
          {history.length > 0 ? (
            <List asChild>
              <ul aria-label={m.history} aria-busy={loadingHistory}>
                {history.map((row) => (
                  <ActionItem
                    key={row.id}
                    row={row}
                    now={now}
                    deviceName={nameOf(row)}
                    context={context}
                  />
                ))}
              </ul>
            </List>
          ) : (
            <p className="text-ui text-muted-foreground">{loadingHistory ? m.loading : m.empty}</p>
          )}
          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              disabled={loadingHistory}
              onClick={consoleState.loadMore}
            >
              {m.loadMore}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
