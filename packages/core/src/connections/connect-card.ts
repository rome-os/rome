import { WIDGET_UI_ICONS, type WidgetUi, type WidgetUiIcon } from "@rome-os/app-runtime";
import { promptCardUi } from "@rome/api-types/prompt-card";
import {
  getEnabledOAuthProviders,
  isOAuthProvider,
  OAUTH_PROVIDER_DESCRIPTORS,
  type OAuthProvider,
} from "./oauth/oauth-providers.js";
import { createRomeCloudOAuthStartUrl } from "./oauth/rome-cloud-oauth.js";
import type { LivePointer, LiveTurn } from "./device/live-route.js";
import type { DeviceLabel } from "./device/report.js";
import type { DeviceConnection } from "./device/repository.js";

/** A device connection kind the card connects: a capability a device reported. */
export interface DeviceKind {
  kind: string;
  label: string;
  /** What it lets Rome do, in English, as the device's page says. */
  summary?: string;
  /** Its name and summary by language, as the device has them. */
  labels?: Record<string, DeviceLabel>;
  /** The icon the device names for it, such as `calendar`. */
  icon?: string;
  /** How it stands now, the best of the devices that report it. */
  state?: DeviceConnection["state"];
  /** The device that reports it, by name, when one does. */
  device?: string;
}

/**
 * How a device kind stands for one turn: the connection the live route
 * chooses, on the asking device alone when there is one.
 */
export interface DeviceKindState {
  state: DeviceConnection["state"] | "not_connected";
  /** The device's name, when the connection has one. */
  device?: string;
  /** The device the guardian asks from, which the card then checks alone. */
  askingDeviceId?: string;
}

/** A live route's pointer as `connect_account` reads it. */
export function deviceKindState(pointer: LivePointer, turn: LiveTurn): DeviceKindState {
  return {
    state: pointer.state,
    ...(pointer.state !== "not_connected" && pointer.device.name
      ? { device: pointer.device.name }
      : {}),
    ...(turn.askingDeviceId ? { askingDeviceId: turn.askingDeviceId } : {}),
  };
}

/** The path of the page that connects a device kind; the phone's app opens its own flow there. */
export function deviceConnectPath(kind: string): string {
  return `/connections/device/${encodeURIComponent(kind)}`;
}

/**
 * The card that connects a connection kind Rome connects itself, such as
 * GitHub, described as data. Core owns it: its events go to core's handlers in
 * `api/routes/widget-events.ts`, which open the kind's authorization page and
 * answer the agent once the connection is working.
 */
export function connectCardUi(
  kind: string,
  kindLabel: string,
  device = false,
  words?: DeviceLabel,
  icon?: string,
): WidgetUi {
  if (device) return deviceConnectCardUi(kind, words ?? { title: kindLabel }, icon);
  const context = { kind };
  return {
    components: [
      { id: "root", component: "Column", children: ["title", "note", "actions"] },
      { id: "title", component: "Text", text: `Connect ${kindLabel}`, variant: "h4" },
      {
        id: "note",
        component: "Text",
        text: `Press Connect and authorize ${kindLabel} in the page that opens, then come back and press I've authorized.`,
        variant: "caption",
      },
      {
        id: "actions",
        component: "Row",
        children: ["dismiss", "check", "connect"],
        justify: "end",
      },
      {
        id: "dismiss",
        component: "Button",
        child: "dismiss-label",
        variant: "borderless",
        action: { event: { name: "dismiss", context } },
      },
      { id: "dismiss-label", component: "Text", text: "Dismiss" },
      {
        id: "check",
        component: "Button",
        child: "check-label",
        action: { event: { name: "check", context } },
      },
      { id: "check-label", component: "Text", text: "I've authorized" },
      {
        id: "connect",
        component: "Button",
        child: "connect-label",
        variant: "primary",
        action: { event: { name: "connect", context } },
      },
      { id: "connect-label", component: "Text", text: "Connect" },
    ],
  };
}

/**
 * The card for a device kind, in the words of the capability's own page: its
 * icon, name and what it lets Rome do, as the device declared them, and Rome's
 * own strings for the buttons, which each reader shows in the guardian's
 * language. Built as the share-location card is, so the two read as one
 * family. A device that declared no summary gets a generic line, and one
 * whose icon no reader draws gets none. The device's app runs the flow and
 * sends `check` itself when it ends, so the card offers no button for it, and
 * core takes that event without one (`CORE_UNSHOWN_EVENTS` in widget-events).
 */
function deviceConnectCardUi(kind: string, words: DeviceLabel, icon?: string): WidgetUi {
  const context = { kind, device: true };
  return promptCardUi({
    ...(icon && isWidgetIcon(icon) ? { icon } : {}),
    title: words.title,
    note: words.summary ?? {
      rome: "deviceConnectNote",
      english: "So your Rome can read the data you allow.",
    },
    dismiss: { label: { rome: "notNow", english: "Not now" }, event: "dismiss", context },
    confirm: { label: { rome: "connect", english: "Connect" }, event: "connect", context },
  });
}

function isWidgetIcon(name: string): name is WidgetUiIcon {
  return (WIDGET_UI_ICONS as readonly string[]).includes(name);
}

/** A device kind's name and summary in the guardian's language, else in English. */
export function deviceWords(device: DeviceKind, language?: string | null): DeviceLabel {
  const local = (language && device.labels?.[language]) || undefined;
  if (local) return local;
  const english = device.labels?.en;
  return {
    title: english?.title ?? device.label,
    ...((english?.summary ?? device.summary)
      ? { summary: english?.summary ?? device.summary }
      : {}),
  };
}

/** The connection kinds the card connects: those Rome connects itself. */
export function connectableKinds(): OAuthProvider[] {
  return getEnabledOAuthProviders();
}

/**
 * The device kinds the card connects: each capability a device reported,
 * once, under its title. A capability named as a kind Rome connects itself
 * is left out, so a kind always means one thing.
 */
export function deviceKinds(connections: readonly DeviceConnection[]): DeviceKind[] {
  const rank = { working: 0, off: 1, broken: 2 } as const;
  const kinds = new Map<string, DeviceKind>();
  // A kind's summary is the first one reported in device-id order, whatever
  // each connection's state, so `connect_account`'s description does not
  // change when the devices' states do.
  const summaries = new Map<string, string>();
  for (const connection of connections) {
    if (connection.summary && !summaries.has(connection.capability)) {
      summaries.set(connection.capability, connection.summary);
    }
  }
  for (const connection of connections) {
    if (isOAuthProvider(connection.capability)) continue;
    const known = kinds.get(connection.capability);
    if (known?.state && rank[known.state] <= rank[connection.state]) continue;
    const summary = summaries.get(connection.capability);
    kinds.set(connection.capability, {
      kind: connection.capability,
      label: known?.label ?? connection.title,
      ...(summary ? { summary } : {}),
      ...(connection.icon ? { icon: connection.icon } : {}),
      ...(connection.labels && Object.keys(connection.labels).length > 0
        ? { labels: connection.labels }
        : {}),
      state: connection.state,
      ...(connection.device.name ? { device: connection.device.name } : {}),
    });
  }
  return [...kinds.values()];
}

/** The connection kind `connect_account` was asked for, or why it can't connect it. */
export function parseConnectAccountInput(
  input: unknown,
  devices: readonly DeviceKind[] = [],
  options: { devicesOnly?: boolean } = {},
):
  | { ok: true; kind: OAuthProvider; device?: undefined }
  | { ok: true; kind: string; device: DeviceKind }
  | { ok: false; error: string } {
  const kind = (input as { kind?: unknown } | null)?.kind;
  const kinds = options.devicesOnly ? [] : connectableKinds();
  if (typeof kind === "string" && kinds.includes(kind as OAuthProvider)) {
    return { ok: true, kind: kind as OAuthProvider };
  }
  const device = devices.find((d) => d.kind === kind);
  if (device) return { ok: true, kind: device.kind, device };
  const all = [...kinds, ...devices.map((d) => d.kind)];
  return { ok: false, error: `kind must be one of ${all.map((k) => `"${k}"`).join(", ")}.` };
}

/**
 * What `connect_account` hands back for a device kind. The card's Connect
 * opens the device's page, which the device's own app turns into its flow.
 */
export function deviceConnectToolOutput(
  device: DeviceKind,
  widgetsShow: boolean,
  /** The device the guardian asks from: the card's checks read its connection alone. */
  askingDeviceId?: string,
  /** The guardian's language (`en`, `zh-CN`): the card's words follow it where the device has them. */
  language?: string | null,
): unknown {
  const words = deviceWords(device, language);
  if (!widgetsShow) {
    return (
      "This conversation cannot show the connect card. Ask the guardian, in a message, " +
      `to turn on ${device.label} in the Rome app on their device, then wait for their reply.`
    );
  }
  return {
    pendingInteraction: true,
    appId: "core",
    render: {
      kind: "inline",
      componentId: CONNECT_CARD_ID,
      props: {
        kind: device.kind,
        label: device.label,
        title: words.title,
        ...(words.summary ? { summary: words.summary } : {}),
        ...(device.icon ? { icon: device.icon } : {}),
        device: true,
        ...(askingDeviceId ? { deviceId: askingDeviceId } : {}),
      },
      builtin: true,
    },
    message:
      `The card to connect ${device.label} has been shown to the guardian. Whether they connected it ` +
      "or dismissed the card arrives as the next turn's prompt — do not call any further tools " +
      "or send another message until then.",
  };
}

/**
 * What a valid `connect_account` call hands back. Where a widget shows, the
 * turn waits on the connect card; `builtin: true` marks it as core's own, which
 * the drain checks against the tool that emitted it. Otherwise the model asks
 * the guardian to connect in Settings, in a message.
 */
export function connectAccountToolOutput(kind: OAuthProvider, widgetsShow: boolean): unknown {
  const label = OAUTH_PROVIDER_DESCRIPTORS[kind].label;
  // Where this instance cannot start the kind's authorization, a card's
  // Connect could only fail: say why instead.
  const link = createRomeCloudOAuthStartUrl(kind);
  if (!link.available) {
    return (
      `${label} can't be connected from the chat on this instance: ${link.unavailableReason ?? "it is not set up"}. ` +
      `Tell the guardian, in a message, to connect ${label} in Settings › Connections.`
    );
  }
  if (!widgetsShow) {
    return (
      "This conversation cannot show the connect card. Ask the guardian, in a message, " +
      `to connect ${label} in Settings › Connections, then wait for their reply.`
    );
  }
  return {
    pendingInteraction: true,
    appId: "core",
    render: { kind: "inline", componentId: CONNECT_CARD_ID, props: { kind }, builtin: true },
    message:
      `The card to connect ${label} has been shown to the guardian. Whether they connected it ` +
      "or dismissed the card arrives as the next turn's prompt — do not call any further tools " +
      "or send another message until then.",
  };
}

/** The connect card described as data, for the connection kind a stored
 *  card's props name, or null when they name none Rome connects. */
export function connectCardUiFromProps(props: unknown): WidgetUi | null {
  const { kind, label, title, summary, icon, device } = (props ?? {}) as {
    kind?: unknown;
    label?: unknown;
    title?: unknown;
    summary?: unknown;
    icon?: unknown;
    device?: unknown;
  };
  if (device === true && typeof kind === "string" && typeof label === "string") {
    // A card stored before the words came from the device names only its label.
    return connectCardUi(
      kind,
      label,
      true,
      {
        title: typeof title === "string" && title ? title : label,
        ...(typeof summary === "string" && summary ? { summary } : {}),
      },
      typeof icon === "string" ? icon : undefined,
    );
  }
  if (typeof kind !== "string" || !isOAuthProvider(kind)) return null;
  return connectCardUi(kind, OAUTH_PROVIDER_DESCRIPTORS[kind].label);
}

export const CONNECT_CARD_ID = "connect-card";
