import { useEffect, useId, useMemo, useState } from "react";
import type { DevicesStatus } from "@rome/api-types/devices";
import type {
  NodeActionRow,
  NodeConnectionStatus,
  NodeOutcome,
} from "@rome/api-types/node-console";
import {
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "@rome-os/ui/page";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { List, ListRow } from "@/components/ui/list-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusIndicator } from "@/lib/connection-status";
import { activeTextFilter, useNodeConsole, type NodeConsoleFilters } from "./use-node-console";

type Device = DevicesStatus["devices"][number];
const ALL = "all";
const OUTCOME_FILTERS = ["ok", "error", "unknown_outcome", "interrupted", "aborted"] as const;

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

function useByteFormat() {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
    const formats = units.map(
      (unit) =>
        new Intl.NumberFormat(i18n.language, {
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
  }, [i18n.language]);
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

function connectionTone(status: NodeConnectionStatus) {
  return status === "online"
    ? ("success" as const)
    : ["retrying", "revoked", "superseded"].includes(status)
      ? ("attention" as const)
      : ("muted" as const);
}

function OutcomeBadge({ row }: { row: NodeActionRow }) {
  const { t } = useTranslation("settings");
  if (row.outcome === "ok" && row.exitCode !== null && row.exitCode !== 0)
    return <Badge variant="warning">{t("devices.console.exitCode", { code: row.exitCode })}</Badge>;
  if (row.outcome === "ok" && row.signal) return <Badge variant="warning">{row.signal}</Badge>;
  const variant: Record<NodeOutcome, "success" | "destructive" | "warning" | "muted"> = {
    ok: "success",
    error: "destructive",
    unknown_outcome: "warning",
    interrupted: "muted",
    aborted: "muted",
  };
  if (!row.outcome) return <Badge variant="info">{t("devices.console.outcome.running")}</Badge>;
  return (
    <Badge variant={variant[row.outcome]}>{t(`devices.console.outcome.${row.outcome}`)}</Badge>
  );
}

function ActionDetails({ row, deviceName }: { row: NodeActionRow; deviceName: string }) {
  const { t, i18n } = useTranslation("settings");
  const bytes = useByteFormat();
  const script = scriptOf(row);
  const entries: [string, React.ReactNode][] = [
    [t("devices.console.detail.device"), `${deviceName} (${row.peer ?? "—"})`],
    [t("devices.console.detail.action"), `${row.action} · ${row.mode}`],
    [t("devices.console.detail.started"), new Date(row.startedAt).toLocaleString(i18n.language)],
  ];
  if (row.endedAt !== null)
    entries.push([
      t("devices.console.detail.duration"),
      formatDuration(row.endedAt - row.startedAt),
    ]);
  if (row.cwd) entries.push([t("devices.console.detail.cwd"), row.cwd]);
  if (row.errorCode) entries.push([t("devices.console.detail.error"), row.errorCode]);
  if (row.exitCode !== null) entries.push([t("devices.console.detail.exit"), String(row.exitCode)]);
  if (row.transfer?.sha256) entries.push(["SHA-256", row.transfer.sha256]);
  entries.push([
    t("devices.console.detail.bytes"),
    t("devices.console.bytes", {
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
      {row.truncated && (
        <p className="text-aux text-muted-foreground">{t("devices.console.truncated")}</p>
      )}
    </div>
  );
}

function ActionItem({
  row,
  now,
  deviceName,
}: {
  row: NodeActionRow;
  now: number;
  deviceName: string;
}) {
  const { t, i18n } = useTranslation("settings");
  const bytes = useByteFormat();
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
                t(row.direction === "in" ? "devices.console.from" : "devices.console.to", {
                  device: deviceName,
                }),
                new Date(row.startedAt).toLocaleTimeString(i18n.language),
                formatDuration(duration),
                output
                  ? t(row.transfer ? "devices.console.copied" : "devices.console.output", {
                      size: bytes(output),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <OutcomeBadge row={row} />
        </button>
      </ListRow>
      {open && (
        <div id={detailsId} className="px-[var(--row-px-md)]">
          <ActionDetails row={row} deviceName={deviceName} />
        </div>
      )}
    </li>
  );
}

/**
 * The rome-node service on this Rome instance: its Gateway connection and the actions it sent
 * to linked computers.
 */
export function NodeConsoleSection({ devices }: { devices: Device[] }) {
  const { t, i18n } = useTranslation("settings");
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
  const consoleState = useNodeConsole(filters);
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

  return (
    <Section aria-labelledby="node-console-title">
      <SectionHeader>
        <SectionHeading>
          <SectionTitle id="node-console-title">{t("devices.console.title")}</SectionTitle>
          <SectionDescription>{t("devices.console.description")}</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      {link !== "open" ? (
        <Card>
          <CardContent>
            <p role="status" className="text-ui text-muted-foreground">
              {t(`devices.console.link.${link}`)}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <p className="text-ui">{t("devices.console.callerLabel")}</p>
                  {caller ? (
                    <StatusIndicator
                      status={{
                        label: t(`devices.connection.${caller.connection}`),
                        tone: connectionTone(caller.connection),
                      }}
                    />
                  ) : (
                    <p className="text-ui text-muted-foreground">—</p>
                  )}
                </div>
                {caller && (
                  <dl className="grid grid-cols-3 gap-4 text-ui sm:text-right">
                    <div>
                      <dt className="text-aux text-muted-foreground">
                        {t("devices.console.since")}
                      </dt>
                      <dd>{formatDuration(now - caller.since)}</dd>
                    </div>
                    <div>
                      <dt className="text-aux text-muted-foreground">
                        {t("devices.console.reconnects")}
                      </dt>
                      <dd>{caller.reconnects}</dd>
                    </div>
                    <div>
                      <dt className="text-aux text-muted-foreground">
                        {t("devices.console.runningCount")}
                      </dt>
                      <dd>{running.length}</dd>
                    </div>
                  </dl>
                )}
              </div>
              {status && (
                <p className="text-aux text-muted-foreground">
                  {t("devices.console.service", {
                    version: status.version,
                    time: new Date(status.startedAt).toLocaleString(i18n.language),
                  })}
                </p>
              )}
            </CardContent>
          </Card>

          {running.length > 0 && (
            <Card>
              <CardContent className="space-y-2">
                <p className="text-ui">{t("devices.console.running")}</p>
                <List asChild>
                  <ul aria-label={t("devices.console.running")}>
                    {running.map((row) => (
                      <ActionItem key={row.id} row={row} now={now} deviceName={nameOf(row)} />
                    ))}
                  </ul>
                </List>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="space-y-4">
              <p className="text-ui">{t("devices.console.history")}</p>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="min-w-48 flex-1"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("devices.console.searchPlaceholder")}
                  aria-label={t("devices.console.search")}
                  aria-describedby={searchShort ? `${uid}-search-hint` : undefined}
                />
                <Select value={peer} onValueChange={setPeer}>
                  <SelectTrigger
                    className="w-auto min-w-36"
                    aria-label={t("devices.console.device")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectItem value={ALL}>{t("devices.console.allDevices")}</SelectItem>
                    {devices.map((device) => (
                      <SelectItem key={device.id} value={device.id.toLowerCase()}>
                        {device.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={outcome} onValueChange={setOutcome}>
                  <SelectTrigger
                    className="w-auto min-w-36"
                    aria-label={t("devices.console.outcomeFilter")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectItem value={ALL}>{t("devices.console.allOutcomes")}</SelectItem>
                    {OUTCOME_FILTERS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`devices.console.outcome.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {host && (
                  <Select value={direction} onValueChange={setDirection}>
                    <SelectTrigger
                      className="w-auto min-w-36"
                      aria-label={t("devices.console.direction")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="end">
                      <SelectItem value={ALL}>{t("devices.console.allDirections")}</SelectItem>
                      <SelectItem value="out">{t("devices.console.sent")}</SelectItem>
                      <SelectItem value="in">{t("devices.console.received")}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
              {searchShort && (
                <p id={`${uid}-search-hint`} className="text-aux text-muted-foreground">
                  {t("devices.console.searchHint")}
                </p>
              )}
              {history.length > 0 ? (
                <List asChild>
                  <ul aria-label={t("devices.console.history")} aria-busy={loadingHistory}>
                    {history.map((row) => (
                      <ActionItem key={row.id} row={row} now={now} deviceName={nameOf(row)} />
                    ))}
                  </ul>
                </List>
              ) : (
                <p className="text-ui text-muted-foreground">
                  {loadingHistory ? t("devices.console.loading") : t("devices.console.empty")}
                </p>
              )}
              {hasMore && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingHistory}
                  onClick={consoleState.loadMore}
                >
                  {t("devices.console.loadMore")}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </Section>
  );
}
