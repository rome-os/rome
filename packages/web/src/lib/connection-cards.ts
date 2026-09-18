/**
 * Presentation adapter for the unified Connections surface.
 *
 * `GET /api/connections` is the single data source — this module adds ONLY
 * presentation: labels, brand keys, ordering, and slot grouping (the Telegram
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
  /** Service name — the brand key, copy key, route id, and ceremony dispatch. */
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
      activeSetupCid: connection.setups?.[grant] ?? null,
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
    service: connection.service,
    label: serviceLabel(connection.service),
    kind: OAUTH_SERVICES.has(connection.service) ? "oauth" : "channel",
    alwaysOn,
    degradation: runtimeDegradation(connection),
    slots,
    connect: connection.connect,
  };
}

/** The Composio ACCOUNT broker as a card. Not a registry connection — its Auth
 *  is the CLI login (`/api/integrations/composio/*`) — but it renders in the
 *  same list, so synthesize its slot in the shared vocabulary. Only appears
 *  once the CLI is installed on the host. */
function composioCard(status: ComposioCliStatus): ConnectionCard {
  return {
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
    // One card per service: the registry currently holds at most one connection
    // per service, so a duplicate would be an upstream invariant break — keep
    // the first and let the detail surface expose the anomaly.
    if (!cards.has(connection.service)) {
      cards.set(connection.service, toCard(connection));
    }
  }

  // A personal account is its own registry service but presents as the
  // `session` slot of its brand's card. The brand card may be absent — a
  // service can be registered without the bot half ever being connected — so
  // the fold creates it rather than dropping the account.
  for (const [service, connection] of folded) {
    const brand = FOLDED_ACCOUNT_SERVICES[service]!;
    const sessionSlots = toSlots(connection, "session");
    const card = cards.get(brand);
    if (card) {
      card.slots.push(...sessionSlots);
      card.degradation ??= runtimeDegradation(connection);
    } else {
      cards.set(brand, {
        service: brand,
        label: serviceLabel(brand),
        kind: "channel",
        alwaysOn: false,
        degradation: runtimeDegradation(connection),
        slots: sessionSlots,
        connect: null,
      });
    }
  }

  if (composio?.installed) {
    cards.set("composio", composioCard(composio));
  }

  return [...cards.values()].sort((a, b) => {
    if ((a.kind === "composio") !== (b.kind === "composio")) return a.kind === "composio" ? 1 : -1;
    const ai = SERVICE_ORDER.indexOf(a.service);
    const bi = SERVICE_ORDER.indexOf(b.service);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? SERVICE_ORDER.length : ai) - (bi === -1 ? SERVICE_ORDER.length : bi);
    }
    return a.service.localeCompare(b.service);
  });
}
