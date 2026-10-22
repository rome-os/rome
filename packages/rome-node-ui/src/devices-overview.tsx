import { useMemo, useState } from "react";
import { Badge } from "@rome-os/ui/badge";
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
import { Switch } from "@rome-os/ui/switch";
import { ChevronRight, Plus } from "lucide-react";
import { clock, formatDuration, platformOf, summarize } from "./format.js";
import { LoadChart } from "./load-chart.js";
import { format, messagesFor, plural, type NodeUiMessages } from "./messages.js";
import { DeviceIcon, NavLink, ResultMark, useNow } from "./parts.js";
import { BUCKET_MS, failureRate, statsByPeer, windowStart, type DeviceStats } from "./stats.js";
import type { NodeDevice, NodeNavigation, NodeThisDevice } from "./types.js";
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
  /** The computer the host page runs on. Its card comes first in its group and has a switch. */
  thisDevice?: NodeThisDevice;
  /** True while the host reads `devices`. */
  loading?: boolean;
}

interface Context {
  m: NodeUiMessages;
  locale: string | undefined;
  navigation: NodeNavigation;
}

const percent = (value: number, locale: string | undefined) =>
  value.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 });

/**
 * One line when the device service or its Gateway connection needs attention. A healthy
 * service shows nothing.
 */
function ServiceProblem({ socket, m }: { socket: NodeSocket; m: NodeUiMessages }) {
  const connection = socket.status?.roles.caller?.connection;
  const text =
    socket.link === "open"
      ? connection === "retrying" || connection === "revoked" || connection === "superseded"
        ? m.gateway[connection]
        : null
      : socket.link === "connecting"
        ? null
        : m.link[socket.link];
  if (!text) return null;
  return (
    <p role="status" className="text-aux text-muted-foreground">
      {text}
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
function Identity({
  device,
  self,
  m,
}: {
  device: NodeDevice;
  self: NodeThisDevice | undefined;
  m: NodeUiMessages;
}) {
  const platform = platformOf(device.platform).label;
  // The app that connects this computer knows its state before Rome Cloud does.
  const status = self
    ? self.state === "connected"
      ? "connected"
      : "not_connected"
    : device.status;
  const statusText =
    self?.state === "connecting" || self?.state === "disabled"
      ? m.thisDevice[self.state]
      : status
        ? m.status[status]
        : null;
  return (
    <span className={cn("flex min-w-0 items-center gap-3", self && "pr-16")}>
      <DeviceIcon platform={device.platform} status={status} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-ui font-medium text-foreground">{device.name}</span>
          {self && (
            <Badge variant="muted" className="h-5 shrink-0">
              {m.thisDevice.label}
            </Badge>
          )}
        </span>
        <span className="block truncate text-aux text-muted-foreground">
          {[platform, statusText].filter(Boolean).join(" · ")}
        </span>
      </span>
    </span>
  );
}

/**
 * This computer's switch. It sits over the card's link at the identity row, because a control
 * cannot nest inside a link. `inset` matches the link's padding.
 */
function ThisDeviceSwitch({
  self,
  m,
  inset,
}: {
  self: NodeThisDevice;
  m: NodeUiMessages;
  inset: string;
}) {
  return (
    <span className={cn("absolute flex h-9 items-center", inset)}>
      <Switch
        checked={self.state !== "disabled"}
        disabled={self.busy}
        onCheckedChange={(checked) => self.onEnabledChange(checked)}
        aria-label={m.thisDevice.toggle}
      />
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
  // Blank rows of the same height hold the card's size until the commands arrive.
  if (!rows.length && loading)
    return (
      <ul className="py-1" aria-hidden>
        {[0, 1, 2].map((index) => (
          <li key={index} className="h-8" />
        ))}
      </ul>
    );
  if (!rows.length)
    return <p className="px-4 py-3 text-aux text-muted-foreground">{m.card.noCommands}</p>;
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
  self,
  stats,
  context,
}: {
  socket: NodeSocket;
  device: NodeDevice;
  self: NodeThisDevice | undefined;
  stats: DeviceStats;
  context: Context;
}) {
  const { m, locale, navigation } = context;
  const rate = failureRate(stats.counts);
  const countText = (count: number) => plural(m.detail.count, count, locale);
  return (
    <Card className="relative gap-0 overflow-hidden py-0">
      <NavLink
        to={navigation.href(device.id)}
        navigation={navigation}
        className="flex flex-col gap-3 p-4 outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        <Identity device={device} self={self} m={m} />
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="flex items-baseline gap-2">
            <span className="text-title tabular-nums text-foreground">
              {stats.counts.all.toLocaleString(locale)}
            </span>
            <span className="text-aux text-muted-foreground">{m.card.commands}</span>
          </span>
          <span className="flex gap-3 text-aux text-muted-foreground tabular-nums">
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
      {self && <ThisDeviceSwitch self={self} m={m} inset="top-4 right-4" />}
      <div className="border-t border-border">
        <LatestCommands socket={socket} device={device} context={context} />
      </div>
      <NavLink
        to={navigation.href(device.id)}
        navigation={navigation}
        className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-ui outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        {m.card.viewAll}
        <span className="inline-flex items-center gap-1 text-aux text-muted-foreground tabular-nums">
          {stats.counts.all.toLocaleString(locale)}
          <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </NavLink>
    </Card>
  );
}

export interface NodeDeviceCardProps {
  device: NodeDevice;
  /** Set when `device` is the computer the host page runs on. Adds its flag and switch. */
  thisDevice?: NodeThisDevice;
  /** Links the card to the device's page. Without it the card is not a link. */
  navigation?: NodeNavigation;
  /** BCP 47 tag for text. Chinese for `zh*`, English otherwise. */
  locale?: string;
}

/**
 * A device's compact card: its name, platform, and connection. `NodeDevices` uses it for devices
 * without recent commands. A host without the device service can show one on its own.
 */
export function NodeDeviceCard({ device, thisDevice, navigation, locale }: NodeDeviceCardProps) {
  const m = messagesFor(locale);
  const identity = <Identity device={device} self={thisDevice} m={m} />;
  return (
    <Card className="relative gap-0 overflow-hidden py-0">
      {navigation ? (
        <NavLink
          to={navigation.href(device.id)}
          navigation={navigation}
          className="flex items-center p-3 outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
        >
          {identity}
        </NavLink>
      ) : (
        <div className="flex items-center p-3">{identity}</div>
      )}
      {thisDevice && <ThisDeviceSwitch self={thisDevice} m={m} inset="top-3 right-3" />}
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
  thisDevice,
  loading = false,
}: NodeDevicesProps) {
  const m = messagesFor(locale);
  const socket = useNodeSocket(url);
  const now = useNow(5000);
  const since = windowStart(now);
  const query = useMemo(() => ({ since, bucketMs: BUCKET_MS }), [since]);
  const { stats, supported, settled } = useStats(socket, query);
  // The cards wait for the devices and their counts, so the page draws its groups once.
  const ready = !loading && settled;
  const byPeer = useMemo(() => (stats ? statsByPeer(stats) : new Map()), [stats]);
  const [showRevoked, setShowRevoked] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const context: Context = { m, locale, navigation };

  // Activity from a device the account no longer lists still shows, under its id.
  // This computer shows before Rome Cloud lists it, under the name the app knows.
  const self = thisDevice?.id.toLowerCase();
  const all =
    thisDevice && !devices.some((device) => device.id.toLowerCase() === self)
      ? [...devices, { id: thisDevice.id, name: thisDevice.name, platform: thisDevice.platform }]
      : devices;
  const known = new Set(all.map((device) => device.id.toLowerCase()));
  const listed: NodeDevice[] = [
    ...all,
    ...[...byPeer.keys()]
      .filter((peer) => peer && !known.has(peer))
      .map((peer) => ({ id: peer, name: peer, status: "unknown" as const })),
  ];
  const statsOf = (device: NodeDevice): DeviceStats | undefined =>
    byPeer.get(device.id.toLowerCase());
  const selfOf = (device: NodeDevice) =>
    device.id.toLowerCase() === self ? thisDevice : undefined;
  const selfFirst = (a: NodeDevice, b: NodeDevice) => Number(!selfOf(a)) - Number(!selfOf(b));
  const revoked = listed.filter((device) => device.status === "revoked");
  const current = listed.filter((device) => device.status !== "revoked");
  const active = current
    .filter((device) => statsOf(device)?.counts.all)
    .sort((a, b) => selfFirst(a, b) || statsOf(b)!.counts.all - statsOf(a)!.counts.all);
  const quiet = current.filter((device) => !statsOf(device)?.counts.all).sort(selfFirst);

  return (
    <Section
      aria-labelledby="node-devices-title"
      aria-busy={!ready || undefined}
      className="@container gap-6"
    >
      <SectionHeader>
        <SectionHeading>
          <SectionTitle id="node-devices-title" className="text-title">
            {m.title}
          </SectionTitle>
          <ServiceProblem socket={socket} m={m} />
        </SectionHeading>
        <SectionActions>
          <Button size="sm" onClick={() => setLinkOpen(true)}>
            <Plus data-icon="inline-start" aria-hidden />
            {m.linkDevice}
          </Button>
        </SectionActions>
      </SectionHeader>

      {ready && !supported && (
        <p className="text-aux text-muted-foreground">{m.statsUnavailable}</p>
      )}

      {ready && listed.length === 0 && (
        <p className="text-ui text-muted-foreground">{m.noDevices}</p>
      )}

      {ready && active.length > 0 && (
        <section
          aria-label={m.activeDevices}
          className="grid gap-4 @2xl:grid-cols-2 @6xl:grid-cols-3"
        >
          {active.map((device) => (
            <DeviceCard
              key={device.id}
              socket={socket}
              device={device}
              self={selfOf(device)}
              stats={statsOf(device)!}
              context={context}
            />
          ))}
        </section>
      )}

      {ready && quiet.length > 0 && (
        <section aria-labelledby="node-devices-quiet" className="flex flex-col gap-3">
          <h3 id="node-devices-quiet" className="text-aux font-medium text-muted-foreground">
            {supported ? m.quietDevices : m.title}
          </h3>
          <div className="grid gap-2 @xl:grid-cols-2 @6xl:grid-cols-3">
            {quiet.map((device) => (
              <NodeDeviceCard
                key={device.id}
                device={device}
                thisDevice={selfOf(device)}
                navigation={navigation}
                locale={locale}
              />
            ))}
          </div>
        </section>
      )}

      {ready && revoked.length > 0 && (
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
          </Button>
          {showRevoked && (
            <div className="grid gap-2 @xl:grid-cols-2 @6xl:grid-cols-3">
              {revoked.map((device) => (
                <NodeDeviceCard
                  key={device.id}
                  device={device}
                  navigation={navigation}
                  locale={locale}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <LinkDeviceDialog open={linkOpen} onClose={() => setLinkOpen(false)} m={m} />
    </Section>
  );
}
