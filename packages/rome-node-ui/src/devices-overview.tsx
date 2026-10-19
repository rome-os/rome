import { useMemo, useState } from "react";
import { Button } from "@rome-os/ui/button";
import { Card } from "@rome-os/ui/card";
import { cn } from "@rome-os/ui/cn";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rome-os/ui/dialog";
import {
  Section,
  SectionActions,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "@rome-os/ui/page";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { clock, formatDuration, platformOf, summarize } from "./format.js";
import { LoadChart } from "./load-chart.js";
import { format, messagesFor, plural, type NodeUiMessages } from "./messages.js";
import { DeviceIcon, NavLink, ResultMark, useNow } from "./parts.js";
import type { NodeStatus } from "./protocol.js";
import { BUCKET_MS, failureRate, statsByPeer, windowStart, type DeviceStats } from "./stats.js";
import type { NodeDevice, NodeNavigation } from "./types.js";
import { useActions, useNodeSocket, useStats, type NodeSocket } from "./use-node-socket.js";

const SETUP_GUIDE = "https://github.com/rome-os/rome/blob/main/packages/rome-node-cli/README.md";

export interface NodeDevicesProps {
  /**
   * WebSocket URL of a backend that forwards the daemon's observation methods unchanged, such as
   * Rome Core's `/ws/node`. A new value opens a new socket.
   */
  url: string;
  /** The devices linked to the account. Activity from an unlisted id shows under that id. */
  devices: NodeDevice[];
  navigation: NodeNavigation;
  /** BCP 47 tag for text, dates, and numbers. Chinese for `zh*`, English otherwise. */
  locale?: string;
  /** When the host last read `devices`, in milliseconds since the epoch. */
  checkedAt?: number;
  refreshing?: boolean;
  onRefresh?: () => void;
}

interface Context {
  m: NodeUiMessages;
  locale: string | undefined;
  navigation: NodeNavigation;
}

/** A coarse age: `8 s`, `3 min`, `2 h`. */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

const percent = (value: number, locale: string | undefined) =>
  value.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 });

function GatewayLine({
  status,
  running,
  now,
  m,
  locale,
}: {
  status: NodeStatus | null;
  running: number;
  now: number;
  m: NodeUiMessages;
  locale: string | undefined;
}) {
  const caller = status?.roles.caller;
  if (!status || !caller) return null;
  const online = caller.connection === "online";
  const facts = [
    online ? format(m.gatewayUp, { duration: formatDuration(now - caller.since) }) : null,
    plural(m.reconnects, caller.reconnects, locale),
    format(m.runningCount, { count: running }),
    `v${status.version}`,
  ].filter(Boolean);
  return (
    <p
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-aux"
      title={format(m.serviceStarted, {
        version: status.version,
        time: new Date(status.startedAt).toLocaleString(locale),
      })}
    >
      <span className="inline-flex items-center gap-2 text-foreground">
        <span
          className={cn(
            "size-2 rounded-full",
            online
              ? "bg-success"
              : caller.connection === "stopped" || caller.connection === "connecting"
                ? "bg-muted-foreground/50"
                : "bg-warning",
          )}
          aria-hidden
        />
        {m.gateway[caller.connection]}
      </span>
      <span className="font-mono text-muted-foreground tabular-nums">{facts.join(" · ")}</span>
    </p>
  );
}

function LinkDeviceDialog({
  open,
  onClose,
  m,
}: {
  open: boolean;
  onClose(): void;
  m: NodeUiMessages;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader onClose={onClose} closeLabel={m.linkDialog.close}>
        <DialogTitle>{m.linkDialog.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <DialogDescription>{m.linkDialog.commandHelp}</DialogDescription>
        <pre className="overflow-x-auto rounded-8 bg-muted p-4 font-mono text-ui">
          <code>rome-node connect</code>
        </pre>
        <p className="text-ui text-muted-foreground">{m.linkDialog.access}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" asChild>
          <a href={SETUP_GUIDE} target="_blank" rel="noopener noreferrer">
            {m.linkDialog.instructions}
          </a>
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The device's name, platform, and connection, shared by both card sizes. */
function Identity({ device, m }: { device: NodeDevice; m: NodeUiMessages }) {
  const platform = platformOf(device.platform).label;
  return (
    <span className="flex min-w-0 items-center gap-3">
      <DeviceIcon platform={device.platform} status={device.status} />
      <span className="min-w-0">
        <span className="block truncate text-ui font-medium text-foreground">{device.name}</span>
        <span className="block truncate font-mono text-aux text-muted-foreground">
          {[platform, device.status ? m.status[device.status] : null].filter(Boolean).join(" · ")}
        </span>
      </span>
    </span>
  );
}

function LatestCommands({
  socket,
  device,
  context: { m, locale, navigation },
}: {
  socket: NodeSocket;
  device: NodeDevice;
  context: Context;
}) {
  const filters = useMemo(() => ({ peer: device.id }), [device.id]);
  const { rows, loading } = useActions(socket, filters, 3, 3);
  if (!rows.length)
    return (
      <p className="px-4 py-3 text-aux text-muted-foreground">
        {loading ? " " : m.card.noCommands}
      </p>
    );
  return (
    <ul className="py-1">
      {rows.map((row) => (
        <li key={row.id}>
          <NavLink
            to={navigation.href(device.id, row.id)}
            navigation={navigation}
            className="grid grid-cols-[0.75rem_auto_minmax(0,1fr)_auto] items-center gap-2 px-4 py-2 outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
          >
            <span className="flex justify-center">
              <ResultMark row={row} m={m} label={false} />
            </span>
            <span className="font-mono text-aux text-muted-foreground tabular-nums">
              {clock(row.startedAt, locale)}
            </span>
            <span className="truncate font-mono text-aux text-foreground">{summarize(row)}</span>
            <span className="font-mono text-aux text-muted-foreground tabular-nums">
              {row.endedAt === null
                ? m.result.running
                : formatDuration(row.endedAt - row.startedAt)}
            </span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function DeviceCard({
  socket,
  device,
  stats,
  context,
}: {
  socket: NodeSocket;
  device: NodeDevice;
  stats: DeviceStats;
  context: Context;
}) {
  const { m, locale, navigation } = context;
  const rate = failureRate(stats.counts);
  const countText = (count: number) => plural(m.detail.count, count, locale);
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <NavLink
        to={navigation.href(device.id)}
        navigation={navigation}
        className="flex flex-col gap-3 p-4 outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        <Identity device={device} m={m} />
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-title tabular-nums text-foreground">
              {stats.counts.all.toLocaleString(locale)}
            </span>
            <span className="text-aux text-muted-foreground">{m.card.commands}</span>
          </span>
          <span className="flex gap-3 font-mono text-aux text-muted-foreground tabular-nums">
            {rate !== null && (
              <span className={cn(rate >= 0.05 && "text-destructive")}>
                {format(m.card.failed, { rate: percent(rate, locale) })}
              </span>
            )}
            {stats.peak && <span>{format(m.card.peak, { count: stats.peak.counts.all })}</span>}
          </span>
        </span>
        <LoadChart
          buckets={stats.buckets}
          bucketMs={BUCKET_MS}
          m={m}
          locale={locale}
          size="sm"
          countText={countText}
        />
      </NavLink>
      <div className="border-t border-border">
        <LatestCommands socket={socket} device={device} context={context} />
      </div>
      <NavLink
        to={navigation.href(device.id)}
        navigation={navigation}
        className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-ui outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        {m.card.viewAll}
        <span className="inline-flex items-center gap-1 font-mono text-aux text-muted-foreground tabular-nums">
          {stats.counts.all.toLocaleString(locale)}
          <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </NavLink>
    </Card>
  );
}

function QuietDeviceCard({ device, context }: { device: NodeDevice; context: Context }) {
  const { m, navigation } = context;
  return (
    <Card className="py-0">
      <NavLink
        to={navigation.href(device.id)}
        navigation={navigation}
        className="flex items-center rounded-12 p-3 outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        <Identity device={device} m={m} />
      </NavLink>
    </Card>
  );
}

/**
 * The devices linked to the account and how busy each one was over the last 24 hours. Active
 * devices get a card with their counts, load chart, and latest commands. The rest get a compact
 * card. Each card links to the device's activity page through `navigation`.
 * Needs `@rome-os/node-ui/styles.css` in the host's Tailwind build.
 */
export function NodeDevices({
  url,
  devices,
  navigation,
  locale,
  checkedAt,
  refreshing = false,
  onRefresh,
}: NodeDevicesProps) {
  const m = messagesFor(locale);
  const socket = useNodeSocket(url);
  const now = useNow(socket.running.length ? 1000 : 5000);
  const since = windowStart(now);
  const query = useMemo(() => ({ since, bucketMs: BUCKET_MS }), [since]);
  const { stats, supported } = useStats(socket, query);
  const byPeer = useMemo(() => (stats ? statsByPeer(stats) : new Map()), [stats]);
  const [showRevoked, setShowRevoked] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const context: Context = { m, locale, navigation };

  // Activity from a device the account no longer lists still shows, under its id.
  const known = new Set(devices.map((device) => device.id.toLowerCase()));
  const listed: NodeDevice[] = [
    ...devices,
    ...[...byPeer.keys()]
      .filter((peer) => peer && !known.has(peer))
      .map((peer) => ({ id: peer, name: peer, status: "unknown" as const })),
  ];
  const statsOf = (device: NodeDevice): DeviceStats | undefined =>
    byPeer.get(device.id.toLowerCase());
  const revoked = listed.filter((device) => device.status === "revoked");
  const current = listed.filter((device) => device.status !== "revoked");
  const active = current
    .filter((device) => statsOf(device)?.counts.all)
    .sort((a, b) => statsOf(b)!.counts.all - statsOf(a)!.counts.all);
  const quiet = current.filter((device) => !statsOf(device)?.counts.all);
  const online = devices.filter((device) => device.status === "connected").length;
  const unknown = devices.filter((device) => device.status === "unknown").length;
  const total = devices.filter((device) => device.status !== "revoked").length;
  const commands = [...byPeer.values()].reduce((sum, value) => sum + value.counts.all, 0);
  const checkedAgo = checkedAt === undefined ? null : elapsed(now - checkedAt);

  return (
    <Section aria-labelledby="node-devices-title" className="@container gap-6">
      <SectionHeader>
        <SectionHeading className="gap-2">
          <span className="flex flex-wrap items-baseline gap-x-3">
            <SectionTitle id="node-devices-title" className="text-title">
              {m.title}
            </SectionTitle>
            <span className="font-mono text-aux text-muted-foreground tabular-nums">
              {[
                // An unchecked device may be online, so a count with unknowns is a lower bound,
                // and zero of them says nothing.
                unknown && !online
                  ? null
                  : format(unknown ? m.onlineAtLeast : m.online, { online, total }),
                stats ? plural(m.commandsInDay, commands, locale) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          {socket.link === "open" ? (
            <GatewayLine
              status={socket.status}
              running={socket.running.length}
              now={now}
              m={m}
              locale={locale}
            />
          ) : (
            <p role="status" className="text-aux text-muted-foreground">
              {m.link[socket.link]}
            </p>
          )}
        </SectionHeading>
        <SectionActions>
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={onRefresh}
              aria-label={m.checkNow}
            >
              <RefreshCw
                data-icon="inline-start"
                className={cn(refreshing && "animate-spin motion-reduce:animate-none")}
                aria-hidden
              />
              <span className="font-mono tabular-nums">
                {refreshing || checkedAgo === null
                  ? m.checking
                  : format(m.checkedAgo, { ago: checkedAgo })}
              </span>
            </Button>
          )}
          <Button size="sm" onClick={() => setLinkOpen(true)}>
            <Plus data-icon="inline-start" aria-hidden />
            {m.linkDevice}
          </Button>
        </SectionActions>
      </SectionHeader>

      {!supported && <p className="text-aux text-muted-foreground">{m.statsUnavailable}</p>}

      {listed.length === 0 && <p className="text-ui text-muted-foreground">{m.noDevices}</p>}

      {active.length > 0 && (
        <section
          aria-label={m.activeDevices}
          className="grid gap-4 @2xl:grid-cols-2 @6xl:grid-cols-3"
        >
          {active.map((device) => (
            <DeviceCard
              key={device.id}
              socket={socket}
              device={device}
              stats={statsOf(device)!}
              context={context}
            />
          ))}
        </section>
      )}

      {quiet.length > 0 && (
        <section aria-labelledby="node-devices-quiet" className="flex flex-col gap-3">
          <h3 id="node-devices-quiet" className="text-aux font-medium text-muted-foreground">
            {supported ? m.quietDevices : m.title}
            <span className="ml-2 font-mono text-subtle-foreground">{quiet.length}</span>
          </h3>
          <div className="grid gap-2 @xl:grid-cols-2 @6xl:grid-cols-3">
            {quiet.map((device) => (
              <QuietDeviceCard key={device.id} device={device} context={context} />
            ))}
          </div>
        </section>
      )}

      {revoked.length > 0 && (
        <section className="flex flex-col gap-3">
          <Button
            variant="ghost"
            size="sm"
            align="start"
            className="self-start text-muted-foreground"
            aria-expanded={showRevoked}
            onClick={() => setShowRevoked((value) => !value)}
          >
            <ChevronRight
              data-icon="inline-start"
              className={cn("transition-transform", showRevoked && "rotate-90")}
              aria-hidden
            />
            {m.revokedDevices}
            <span className="font-mono text-subtle-foreground">{revoked.length}</span>
          </Button>
          {showRevoked && (
            <div className="grid gap-2 @xl:grid-cols-2 @6xl:grid-cols-3">
              {revoked.map((device) => (
                <QuietDeviceCard key={device.id} device={device} context={context} />
              ))}
            </div>
          )}
        </section>
      )}

      <LinkDeviceDialog open={linkOpen} onClose={() => setLinkOpen(false)} m={m} />
    </Section>
  );
}
