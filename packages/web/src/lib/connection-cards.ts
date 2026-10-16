/**
 * Presentation adapter for the unified Connections surface.
 *
 * `GET /api/connections` is the single data source — this module adds ONLY
 * presentation: labels, brand keys, ordering, and slot grouping. A service can
 * hold several Connections, each backing one account (channel), and each
 * account gets its own card routed by its channel name. Only the first account
 * of a service takes the folded slots below (the Telegram
 * personal account folds onto the Telegram card as its `session` slot; the
 * Composio account broker appends as a synthetic card since it is not a
 * registry connection). Connection state stays registry vocabulary
 * (`GrantState`) verbatim — the old client-side fold of
 * `/api/channels/status` + `/api/integrations` and its
 * `UnifiedConnection`/`CredentialSlot` vocabulary are gone.
 *
 * Two presentation rules carried over from the old fold:
 *   - Always-on — webchat has no ceremony and always reads Connected.
 *   - Unavailable ≠ disconnected — an OAuth service whose connect hint reports
 *     `available: false` renders as "Unavailable" with the reason, not as a
 *     plain "Not connected".
 */

import type {
  ApiConnection,
  CapabilityDegradation,
  ConnectHint,
  GrantDisplay,
  GrantState,
} from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";

/** The copy key a slot renders under (`connections.cards.<service>.<key>`). */
export type SlotKey = "bot" | "session" | "user";

/** One independently-connectable credential on a card, in registry vocabulary. */
export interface ConnectionSlot {
  key: SlotKey;
  /** Ledger connection id backing this slot; null until the service's connect
   *  ceremony mints the row (offerable placeholder). */
  connectionId: string | null;
  /** The registry grant name this slot revokes (`DELETE
   *  /api/connections/:id/grants/:grant`); null for zero-grant services. */
  grant: string | null;
  state: GrantState;
  display: GrantDisplay | null;
  /** Folded display identity (displayName, else handle, else email). */
  identity: string | null;
  /** The id of the live conferral setup for this grant, if one is
   *  in progress; the connect card re-attaches to it on reopen. Null otherwise. */
  activeSetupCid: string | null;
}

export interface ConnectionCard {
  /** The card's route id (`/settings/connections/:route`): the account's
   *  channel id when it has one, else the service. The first account of a
   *  service routes as the service (`feishu`), and later ones by their opaque
   *  channel id. */
  route: string;
  /** Service name — the brand key, copy key, and ceremony dispatch. */
  service: string;
  label: string;
  kind: "channel" | "oauth" | "composio";
  /** Webchat: boot-wired, no ceremony, always Connected. */
  alwaysOn: boolean;
  /** Transient runtime impairment. The underlying grant can remain authorized
   *  and recover automatically while this warning is present. */
  degradation: CapabilityDegradation | null;
  slots: ConnectionSlot[];
  connect: ConnectHint | null;
  /** The account's channel id; null for placeholders and services without a
   *  Talk. Never shown on screens. */
  channel: string | null;
  /** Canonical id of the agent linked to this account, or null when the account
   *  stays silent. */
  linkedAgent: string | null;
  /** Whether the server reports links, so the link route exists. A core that
   *  serves accounts before agent links omits `linkedAgent`, and the picker
   *  stays hidden. */
  linkReported: boolean;
  /** Whether the service offers "add another account". */
  severalAccounts: boolean;
}

/** Fixed dashboard ordering: Talk channels, webchat, OAuth services; services
 *  the registry reports that we have no order for follow alphabetically, and
 *  the Composio broker card always closes the list. */
const SERVICE_ORDER = [
  "telegram",
  "whatsapp",
  "wechat",
  "linkedin",
  "discord",
  "email",
  "feishu",
  "agents",
  "webchat",
  "github",
  "google",
  "slack",
];

const LABELS: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  wechat: "WeChat",
  linkedin: "LinkedIn",
  discord: "Discord",
  email: "Email",
  feishu: "Feishu",
  agents: "Agents",
  webchat: "Webchat",
  github: "GitHub",
  google: "Google",
  slack: "Slack",
  composio: "Composio",
};

const OAUTH_SERVICES = new Set(["github", "google", "slack"]);

/** The copy slot key each registry grant renders under. A channel's single
 *  Talk grant is the generic `bot` slot whatever the grant is named; an OAuth
 *  conferral is the `user` slot (Slack's `workspace` grant included). */
const SLOT_KEY_BY_GRANT: Record<string, Record<string, SlotKey>> = {
  telegram: { bot: "bot" },
  whatsapp: { session: "bot" },
  wechat: { account: "bot" },
  linkedin: { session: "bot" },
  discord: { bot: "bot" },
  email: { inbox: "bot" },
  feishu: { app: "bot" },
  agents: { cloud: "bot" },
  github: { user: "user" },
  google: { user: "user" },
  slack: { workspace: "user" },
};

function slotKeyFor(service: string, grant: string): SlotKey {
  const mapped = SLOT_KEY_BY_GRANT[service]?.[grant];
  if (mapped) return mapped;
  return OAUTH_SERVICES.has(service) ? "user" : "bot";
}

function foldIdentity(display: GrantDisplay | null): string | null {
  return display?.displayName || display?.handle || display?.email || null;
}

function toSlots(connection: ApiConnection, key?: SlotKey): ConnectionSlot[] {
  return Object.entries(connection.grants).map(([grant, state]) => {
    const display = connection.display[grant] ?? null;
    return {
      key: key ?? slotKeyFor(connection.service, grant),
      connectionId: connection.id,
      grant,
      state,
      display,
      identity: foldIdentity(display),
      activeSetupCid: connection.setups[grant] ?? null,
    };
  });
}

/**
 * Human-readable name for a service id. Exported because brand badges are
 * `aria-hidden`, so surfaces that show a provider only as an icon still need
 * its name in accessible text.
 */
export function serviceLabel(service: string): string {
  return LABELS[service] ?? service.charAt(0).toUpperCase() + service.slice(1);
}

function runtimeDegradation(connection: ApiConnection): CapabilityDegradation | null {
  for (const status of Object.values(connection.capabilities)) {
    if (status.state === "unlocked" && status.degradation) return status.degradation;
  }
  return null;
}

/** The card route an account opens at: its channel id, else its service for a
 *  placeholder or a core that predates accounts. */
export function connectionRoute(connection: ApiConnection): string {
  return connection.channel || connection.service;
}

function toCard(connection: ApiConnection): ConnectionCard {
  const alwaysOn = connection.service === "webchat";
  const slots = alwaysOn
    ? // Zero-grant: synthesize the single always-authorized presentation slot.
      [
        {
          key: "bot" as const,
          connectionId: connection.id,
          grant: null,
          state: "authorized" as const,
          display: null,
          identity: null,
          activeSetupCid: null,
        },
      ]
    : toSlots(connection);
  return {
    route: connectionRoute(connection),
    service: connection.service,
    // Several accounts of one service are told apart by name once the whole
    // list is known (`labelAccounts`).
    label: serviceLabel(connection.service),
    kind: OAUTH_SERVICES.has(connection.service) ? "oauth" : "channel",
    alwaysOn,
    degradation: runtimeDegradation(connection),
    slots,
    connect: connection.connect,
    // Read defensively: a core that predates accounts omits these fields.
    channel: connection.channel ?? null,
    // The bot's link only. A folded personal account (`telegram_user`) keeps
    // its own link, which this card does not show or set yet.
    linkedAgent: connection.linkedAgent ?? null,
    linkReported: connection.linkedAgent !== undefined,
    severalAccounts: connection.severalAccounts === true,
  };
}

/** The Composio ACCOUNT broker as a card. Not a registry connection — its Auth
 *  is the CLI login (`/api/integrations/composio/*`) — but it renders in the
 *  same list, so synthesize its slot in the shared vocabulary. Only appears
 *  once the CLI is installed on the host. */
function composioCard(status: ComposioCliStatus): ConnectionCard {
  return {
    route: "composio",
    service: "composio",
    label: serviceLabel("composio"),
    kind: "composio",
    alwaysOn: false,
    degradation: null,
    slots: [
      {
        key: "user",
        connectionId: null,
        grant: null,
        state: status.loggedIn ? "authorized" : "unauthorized",
        display: null,
        identity: null,
        activeSetupCid: null,
      },
    ],
    connect: null,
    channel: null,
    linkedAgent: null,
    linkReported: false,
    severalAccounts: false,
  };
}

/** Personal-account services that present as a `session` slot on their brand's
 *  card rather than a card of their own. One brand, two credentials: Telegram's
 *  bot and the guardian's own account; WeChat's official bot and the guardian's
 *  own account read off the hosting VM. */
const FOLDED_ACCOUNT_SERVICES: Record<string, string> = {
  telegram_user: "telegram",
  wechat_user: "wechat",
};

export function buildConnectionCards(
  connections: ApiConnection[],
  composio?: ComposioCliStatus | null,
): ConnectionCard[] {
  const cards = new Map<string, ConnectionCard>();
  const folded = new Map<string, ApiConnection>();

  for (const connection of connections) {
    if (FOLDED_ACCOUNT_SERVICES[connection.service]) {
      folded.set(connection.service, connection);
      continue;
    }
    // One card per account, keyed by its route. Two connections claiming one
    // route would be an upstream invariant break — keep the first and let the
    // detail surface expose the anomaly.
    const card = toCard(connection);
    if (!cards.has(card.route)) {
      cards.set(card.route, card);
    }
  }

  // A personal account is its own registry service but presents as the
  // `session` slot of its brand's card. The brand card may be absent — a
  // service can be registered without the bot half ever being connected — so
  // the fold creates it rather than dropping the account. The fold lands on
  // the brand's first account, whose route is the brand itself.
  for (const [service, connection] of folded) {
    const brand = FOLDED_ACCOUNT_SERVICES[service]!;
    const sessionSlots = toSlots(connection, "session");
    const card = cards.get(brand);
    if (card) {
      card.slots.push(...sessionSlots);
      card.degradation ??= runtimeDegradation(connection);
    } else {
      cards.set(brand, {
        route: brand,
        service: brand,
        label: serviceLabel(brand),
        kind: "channel",
        alwaysOn: false,
        degradation: runtimeDegradation(connection),
        slots: sessionSlots,
        connect: null,
        channel: null,
        linkedAgent: null,
        linkReported: false,
        severalAccounts: false,
      });
    }
  }

  if (composio?.installed) {
    cards.set("composio", composioCard(composio));
  }

  const sorted = [...cards.values()].sort((a, b) => {
    if ((a.kind === "composio") !== (b.kind === "composio")) return a.kind === "composio" ? 1 : -1;
    const ai = SERVICE_ORDER.indexOf(a.service);
    const bi = SERVICE_ORDER.indexOf(b.service);
    if (ai !== -1 || bi !== -1) {
      const byService =
        (ai === -1 ? SERVICE_ORDER.length : ai) - (bi === -1 ? SERVICE_ORDER.length : bi);
      if (byService !== 0) return byService;
    } else if (a.service !== b.service) {
      return a.service.localeCompare(b.service);
    }
    return compareAccounts(a, b);
  });
  labelAccounts(sorted);
  return sorted;
}

/** Within one service the first account leads. Later accounts keep the order
 *  the server lists them in, since their channel ids are opaque. */
function compareAccounts(a: ConnectionCard, b: ConnectionCard): number {
  if ((a.route === a.service) !== (b.route === b.service)) return a.route === a.service ? -1 : 1;
  return 0;
}

/** When a service has several accounts, labels each one "Feishu · <bot name>"
 *  so the cards tell them apart. An account without a name yet (one whose
 *  setup has not run) keeps the plain service label, and a channel id never
 *  reaches a label. A service with one account keeps the plain label. */
function labelAccounts(cards: ConnectionCard[]): void {
  const perService = new Map<string, number>();
  for (const card of cards) perService.set(card.service, (perService.get(card.service) ?? 0) + 1);
  for (const card of cards) {
    if ((perService.get(card.service) ?? 0) < 2) continue;
    const identity = card.slots.find((slot) => slot.key !== "session")?.identity;
    if (identity) card.label = `${serviceLabel(card.service)} · ${identity}`;
  }
}
