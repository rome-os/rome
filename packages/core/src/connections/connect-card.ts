import type { WidgetUi } from "@rome-os/app-runtime";
import {
  getEnabledOAuthProviders,
  isOAuthProvider,
  OAUTH_PROVIDER_DESCRIPTORS,
  type OAuthProvider,
} from "./oauth/oauth-providers.js";

/**
 * The card that connects a connection kind Rome connects itself, such as
 * GitHub, described as data. Core owns it: its events go to core's handlers in
 * `api/routes/widget-events.ts`, which open the kind's authorization page and
 * answer the agent once the connection is working.
 */
export function connectCardUi(kind: string, kindLabel: string): WidgetUi {
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

/** The connection kinds the card connects: those Rome connects itself. */
export function connectableKinds(): OAuthProvider[] {
  return getEnabledOAuthProviders();
}

/** The connection kind `connect_account` was asked for, or why it can't connect it. */
export function parseConnectAccountInput(
  input: unknown,
): { ok: true; kind: OAuthProvider } | { ok: false; error: string } {
  const kind = (input as { kind?: unknown } | null)?.kind;
  const kinds = connectableKinds();
  if (typeof kind !== "string" || !kinds.includes(kind as OAuthProvider)) {
    return {
      ok: false,
      error: `kind must be one of ${kinds.map((k) => `"${k}"`).join(", ")}.`,
    };
  }
  return { ok: true, kind: kind as OAuthProvider };
}

/**
 * What a valid `connect_account` call hands back. Where a widget shows, the
 * turn waits on the connect card; `builtin: true` marks it as core's own, which
 * the drain checks against the tool that emitted it. Otherwise the model asks
 * the guardian to connect in Settings, in a message.
 */
export function connectAccountToolOutput(kind: OAuthProvider, widgetsShow: boolean): unknown {
  const label = OAUTH_PROVIDER_DESCRIPTORS[kind].label;
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
  const kind = (props as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string" || !isOAuthProvider(kind)) return null;
  return connectCardUi(kind, OAUTH_PROVIDER_DESCRIPTORS[kind].label);
}

export const CONNECT_CARD_ID = "connect-card";
