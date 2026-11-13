// The Concierge's list of services: Rome's connections as `GET /connections`
// projects them, the services watch providers connect themselves (the
// connector's Composio toolkits), and each one's watch capability as its
// provider fills it. `GET /concierge/connectors` and the following_list action
// both read it through `ConciergeFollowing.list()`; the action answers the
// agent's view of it (`agentViewOf`).

import type {
  ConciergeCapabilityStatus,
  ConciergeConnectEntry,
  ConciergeConnectorDto,
  ConciergeConnectorsResponse,
  ConciergeFollowDto,
  ConciergeFollowKindDto,
  ConciergeFollowOptionDto,
  ConciergeWatchCapability,
} from "@rome/api-types/concierge";
import type { ConnectionView } from "../api/routes/connections.js";

/** A service a watch provider connects itself, such as a Composio toolkit. */
export interface ProviderService {
  service: string;
  label: string;
  /** The provider's id for the service's mark, such as a Composio catalog glyph. */
  glyph?: string;
  state: "working" | "broken" | null;
  connect: Extract<ConciergeConnectEntry, { kind: "composio" }> | null;
}

/** The watch section a provider gives for one service, before follows are added. */
export interface ProviderWatchSection {
  service: string;
  label: string;
  status: "ready" | "not_connected" | "no_relay" | "error";
  statusReason?: string;
  /** The kinds whose events are not arriving because their subscription at the source is missing, with what to do. */
  undelivered?: { kinds: string[]; reason: string };
  account?: string;
  target: { format: string; example: string } | null;
  kinds: ConciergeFollowKindDto[];
  options: ConciergeFollowOptionDto[];
}

/**
 * A provider's watch status in the connection model's words. Not connected
 * needs access; connected but unable to receive events (no relay mailbox, the
 * account unreadable) is unlocked and degraded, with the reason.
 */
export function watchCapabilityStatus(section: ProviderWatchSection): ConciergeCapabilityStatus {
  switch (section.status) {
    case "ready":
      return { state: "unlocked" };
    case "not_connected":
      return { state: "needs-auth", missingGrants: [] };
    default:
      return {
        state: "unlocked",
        degradation: { reason: section.statusReason ?? section.status },
      };
  }
}

function watchCapability(
  base: ConciergeCapabilityStatus,
  section: ProviderWatchSection | undefined,
  follows: ConciergeFollowDto[],
): ConciergeWatchCapability {
  if (!section) return base;
  return {
    ...watchCapabilityStatus(section),
    ...(section.account ? { account: section.account } : {}),
    target: section.target,
    kinds: section.kinds,
    options: section.options,
    follows,
  };
}

/** The account a connection reaches, as a person reads it: a handle, an address, a name. */
function accountOf(view: ConnectionView): string | null {
  for (const display of Object.values(view.display)) {
    const text = display?.handle ?? display?.email ?? display?.displayName;
    if (text) return text;
  }
  return view.account?.id ?? null;
}

function connectOfView(view: ConnectionView): ConciergeConnectEntry | null {
  if (view.state === "working") return null;
  return view.connect ? { kind: "rome_oauth", ...view.connect } : { kind: "dashboard" };
}

const isWatchable = (entry: ConciergeConnectorDto) =>
  entry.capabilities.watch.state !== "unsupported";

/**
 * Every service, unfiltered: each connection and placeholder, then each
 * provider service, with the watch capability overlaid where a provider
 * watches it. Watchable services come first.
 */
export function mergeConnectors(input: {
  connections: ConnectionView[];
  services: ProviderService[];
  watch: ProviderWatchSection[];
  followsOf(service: string): ConciergeFollowDto[];
}): ConciergeConnectorDto[] {
  const sectionOf = (service: string) => input.watch.find((s) => s.service === service);
  const fromConnections: ConciergeConnectorDto[] = input.connections.map((view) => ({
    service: view.connectionKind,
    label: view.kindLabel,
    icon: `brand:${view.connectionKind}`,
    origin: "connection",
    connectionId: view.id,
    state: view.state,
    account: accountOf(view),
    connect: connectOfView(view),
    capabilities: {
      chat: view.capabilities.chat,
      act: view.capabilities.act,
      watch: watchCapability(
        view.capabilities.watch,
        sectionOf(view.connectionKind),
        input.followsOf(view.connectionKind),
      ),
    },
  }));
  // A Composio toolkit may share a name with a different Rome connection
  // (Discord the toolkit, Discord the chat channel): both are listed, told
  // apart by `origin`.
  const fromProviders: ConciergeConnectorDto[] = input.services.map((service) => {
    const section = sectionOf(service.service);
    // Composio's access is all or nothing: connected, it lets a task chat act.
    const act: ConciergeCapabilityStatus =
      service.state === "working"
        ? { state: "unlocked" }
        : { state: "needs-auth", missingGrants: [] };
    return {
      service: service.service,
      label: service.label,
      icon: service.glyph ? `glyph:${service.glyph}` : null,
      origin: "composio",
      connectionId: null,
      state: service.state,
      account: section?.account ?? null,
      connect: service.connect,
      capabilities: {
        chat: { state: "unsupported" },
        act,
        watch: watchCapability({ state: "unsupported" }, section, input.followsOf(service.service)),
      },
    };
  });
  const all = [...fromConnections, ...fromProviders];
  return [...all.filter(isWatchable), ...all.filter((entry) => !isWatchable(entry))];
}

/**
 * The following list as the Concierge reads it, leaving out what only a
 * client draws with: each entry's icon, connection id and how to connect it.
 * Without `service`, each watch capability also leaves out its catalog
 * (target format, kinds and options), which a follow card needs for one
 * service only. With `service`, only that service's entries, catalog
 * included. A Composio toolkit and a connection may share a name, so `origin`
 * stays wherever two entries do.
 */
export function agentViewOf(list: ConciergeConnectorsResponse, service?: string) {
  const entries = service
    ? list.connectors.filter((entry) => entry.service === service)
    : list.connectors;
  if (service && entries.length === 0) {
    throw new Error(`No service ${service}. Call the list without service for their names.`);
  }
  const shared = new Set(
    list.connectors
      .map((entry) => entry.service)
      .filter((name, index, names) => names.indexOf(name) !== index),
  );
  return {
    connectors: entries.map((entry) => {
      const { target, kinds, options, ...watch } = entry.capabilities.watch;
      return {
        service: entry.service,
        ...(entry.label !== entry.service ? { label: entry.label } : {}),
        ...(shared.has(entry.service) ? { origin: entry.origin } : {}),
        state: entry.state,
        ...(entry.account ? { account: entry.account } : {}),
        capabilities: {
          chat: entry.capabilities.chat,
          act: entry.capabilities.act,
          watch: service ? entry.capabilities.watch : watch,
        },
      };
    }),
    rules: list.rules,
  };
}
