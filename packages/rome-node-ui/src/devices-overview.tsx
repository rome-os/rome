import { useMemo, useRef, useState, type ReactNode } from "react";
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
import { ChevronRight, Plus } from "lucide-react";
import { DeviceMenu } from "./device-manage.js";
import { platformOf } from "./format.js";
import { messagesFor, plural, type NodeUiMessages } from "./messages.js";
import { DeviceIcon, NavLink, useNow } from "./parts.js";
import { Sparkline } from "./sparkline.js";
import { BUCKET_MS, BUCKETS, statsByPeer, windowStart, type DeviceStats } from "./stats.js";
import type { NodeDevice, NodeDeviceManage, NodeNavigation, NodeThisDevice } from "./types.js";
import { useNodeSocket, useStats, type NodeSocket } from "./use-node-socket.js";

const SETUP_GUIDE = "https://github.com/rome-os/rome/blob/main/packages/rome-node-cli/README.md";

export interface NodeDevicesProps {
  /**
   * WebSocket URL of a backend that forwards the daemon's observation methods unchanged, such as
   * Rome Core's `/ws/node`. A new value opens a new socket.
   */
  url: string;
  /** The devices linked to the account. Activity from a device not listed here is not shown. */
  devices: NodeDevice[];
  navigation: NodeNavigation;
  /** BCP 47 tag for text, dates, and numbers. Chinese for `zh*`, English otherwise. */
  locale?: string;
  /** The computer the host page runs on. Its card comes first, and its menu connects it. */
  thisDevice?: NodeThisDevice;
  /** Rename, disconnect, and remove in each card's menu. */
  manage?: NodeDeviceManage;
  /** True while the host reads `devices`. */
  loading?: boolean;
}

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

/** The device's name, platform, and connection. */
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
    <span className="flex min-w-0 flex-1 items-center gap-3">
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

export interface NodeDeviceCardProps {
  device: NodeDevice;
  /** Set when `device` is the computer the host page runs on. Adds its flag and connect actions. */
  thisDevice?: NodeThisDevice;
  /** Rename, disconnect, and remove in the card's menu. */
  manage?: NodeDeviceManage;
  /** Links the card to the device's page. Without it the card is not a link. */
  navigation?: NodeNavigation;
  /** BCP 47 tag for text. Chinese for `zh*`, English otherwise. */
  locale?: string;
}

/**
 * A device's card: its name, platform, and connection. `NodeDevices` adds a line with its recent
 * commands. A host without the device service can show one on its own.
 */
export function NodeDeviceCard({
  device,
  thisDevice,
  navigation,
  manage,
  locale,
}: NodeDeviceCardProps) {
  return (
    <DeviceCard
      device={device}
      self={thisDevice}
      navigation={navigation}
      manage={manage}
      m={messagesFor(locale)}
    />
  );
}

function DeviceCard({
  device,
  self,
  navigation,
  manage,
  m,
  chart,
}: {
  device: NodeDevice;
  self: NodeThisDevice | undefined;
  navigation: NodeNavigation | undefined;
  manage?: NodeDeviceManage;
  m: NodeUiMessages;
  chart?: ReactNode;
}) {
  const menu = Boolean(manage || self);
  // The menu sits over the right edge, so the row leaves it room. A row too narrow for the
  // name and the curve drops the curve.
  const body = (
    <span className={cn("@container min-w-0 flex-1", menu && "pr-10")}>
      <span className="flex items-center gap-3">
        <Identity device={device} self={self} m={m} />
        {chart && <span className="hidden @2xs:contents">{chart}</span>}
      </span>
    </span>
  );
  return (
    <Card className="relative gap-0 overflow-hidden py-0">
      {navigation ? (
        <NavLink
          to={navigation.href(device.id)}
          navigation={navigation}
          className="flex items-center p-3 outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
        >
          {body}
        </NavLink>
      ) : (
        <div className="flex items-center p-3">{body}</div>
      )}
      {menu && (
        // Over the card's link at the identity row, because a control cannot nest inside a link.
        <span className="absolute top-3 right-3 flex h-9 items-center">
          <DeviceMenu device={device} self={self} manage={manage} m={m} />
        </span>
      )}
    </Card>
  );
}

/** The start of the latest bucket with a command, or -1 without one. */
function lastActive(stats: DeviceStats | undefined): number {
  const buckets = stats?.buckets ?? [];
  for (let index = buckets.length - 1; index >= 0; index -= 1)
    if (buckets[index]!.counts.all) return buckets[index]!.start;
  return -1;
}

/** The device's curve. A device without commands draws an empty one. */
function chartOf(
  stats: DeviceStats | undefined,
  since: number,
  m: NodeUiMessages,
  locale: string | undefined,
) {
  const buckets =
    stats?.buckets ??
    Array.from({ length: BUCKETS }, (_, index) => ({
      start: since + index * BUCKET_MS,
      counts: { all: 0, running: 0, succeeded: 0, failed: 0, no_result: 0 },
    }));
  return (
    <Sparkline buckets={buckets} label={plural(m.card.chart, stats?.counts.all ?? 0, locale)} />
  );
}

/**
 * Keeps the order the cards had when the page first drew them, so a device that connects,
 * disconnects, or runs a command changes its card in place. A device that appears later goes last.
 */
function useFirstOrder(
  devices: NodeDevice[],
  ready: boolean,
  rank: (list: NodeDevice[]) => NodeDevice[],
) {
  const order = useRef<string[] | null>(null);
  if (!ready) return [];
  const key = (device: NodeDevice) => device.id.toLowerCase();
  order.current ??= rank(devices).map(key);
  const known = new Set(order.current);
  order.current.push(...devices.map(key).filter((id) => !known.has(id)));
  const position = new Map(order.current.map((id, index) => [id, index]));
  return [...devices].sort((a, b) => position.get(key(a))! - position.get(key(b))!);
}

/**
 * The devices linked to the account, one card each with a curve of its commands over the last
 * 24 hours.
 * The cards keep the order they had when the page drew them: this computer, the connected
 * devices, then the rest, each by its latest command. Each card links to the device's activity
 * page through `navigation`. Needs `@rome-os/node-ui/styles.css` in the host's Tailwind build.
 */
export function NodeDevices({
  url,
  devices,
  navigation,
  locale,
  thisDevice,
  manage,
  loading = false,
}: NodeDevicesProps) {
  const m = messagesFor(locale);
  const socket = useNodeSocket(url);
  const now = useNow(5000);
  const since = windowStart(now);
  const query = useMemo(() => ({ since, bucketMs: BUCKET_MS }), [since]);
  const { stats, supported, settled } = useStats(socket, query);
  // The cards wait for the devices and their counts, so the page draws them once.
  const ready = !loading && settled;
  const byPeer = useMemo(() => (stats ? statsByPeer(stats) : new Map()), [stats]);
  const [showRevoked, setShowRevoked] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  // Only the account's devices show, so a removed device leaves even with recent activity.
  // This computer shows before Rome Cloud lists it, under the name the app knows.
  const self = thisDevice?.id.toLowerCase();
  const listed: NodeDevice[] =
    thisDevice && !devices.some((device) => device.id.toLowerCase() === self)
      ? [...devices, { id: thisDevice.id, name: thisDevice.name, platform: thisDevice.platform }]
      : devices;
  const statsOf = (device: NodeDevice): DeviceStats | undefined =>
    byPeer.get(device.id.toLowerCase());
  const selfOf = (device: NodeDevice) =>
    device.id.toLowerCase() === self ? thisDevice : undefined;
  const connected = (device: NodeDevice) =>
    selfOf(device) ? thisDevice!.state === "connected" : device.status === "connected";
  const revoked = listed.filter((device) => device.status === "revoked");
  const current = useFirstOrder(
    listed.filter((device) => device.status !== "revoked"),
    ready,
    (list) =>
      list
        .map((device) => ({ device, last: lastActive(statsOf(device)) }))
        .sort(
          (a, b) =>
            Number(!selfOf(a.device)) - Number(!selfOf(b.device)) ||
            Number(!connected(a.device)) - Number(!connected(b.device)) ||
            b.last - a.last ||
            a.device.name.localeCompare(b.device.name, locale),
        )
        .map(({ device }) => device),
  );

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

      {current.length > 0 && (
        <ul aria-label={m.title} className="grid gap-2 @xl:grid-cols-2 @6xl:grid-cols-3">
          {current.map((device) => (
            <li key={device.id} className="grid">
              <DeviceCard
                device={device}
                self={selfOf(device)}
                navigation={navigation}
                manage={manage}
                m={m}
                chart={supported && chartOf(statsOf(device), since, m, locale)}
              />
            </li>
          ))}
        </ul>
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
                  manage={manage}
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
