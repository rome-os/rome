import type { ShownUi } from "@rome-os/app-runtime";
import { CATALOG } from "./catalog.js";

/** The paths under this app's API that the connect card reads and posts to. */
export const CONNECT_CARD_PATH = "connect-card";

/** What the agent reads once the card is answered. */
export type ConnectAnswer =
  | { toolkit: string; status: "connected" }
  | { toolkit: string; dismissed: true };

export function toolkitName(toolkit: string): string {
  return CATALOG.find((entry) => entry.slug === toolkit)?.name ?? toolkit;
}

/**
 * The card that connects a toolkit through Composio, described as data. The
 * agent waits on it. Connect opens Composio's authorization page; Check asks
 * the app whether the toolkit is connected now; either answers the agent once
 * it is. Dismiss answers that the guardian declined.
 */
export function connectWidget(toolkit: string): ShownUi {
  const entry = CATALOG.find((c) => c.slug === toolkit);
  const name = entry?.name ?? toolkit;
  const context = { toolkit };
  return {
    text: `To connect ${name}, open Settings › Connections and click Connect for "${name}".`,
    waits: true,
    bind: { "/card": `${CONNECT_CARD_PATH}/${toolkit}` },
    ui: {
      components: [
        { id: "root", component: "Column", children: ["title", "scope", "note", "actions"] },
        { id: "title", component: "Text", text: `Connect ${name}`, variant: "h4" },
        { id: "scope", component: "Text", text: entry?.scope ?? "", variant: "caption" },
        { id: "note", component: "Text", text: { path: "/card/note" }, variant: "caption" },
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
          action: { event: { name: `${CONNECT_CARD_PATH}/dismiss`, context } },
        },
        { id: "dismiss-label", component: "Text", text: "Dismiss" },
        {
          id: "check",
          component: "Button",
          child: "check-label",
          action: { event: { name: `${CONNECT_CARD_PATH}/check`, context } },
        },
        { id: "check-label", component: "Text", text: "I've authorized" },
        {
          id: "connect",
          component: "Button",
          child: "connect-label",
          variant: "primary",
          action: { event: { name: `${CONNECT_CARD_PATH}/connect`, context } },
        },
        { id: "connect-label", component: "Text", text: "Connect" },
      ],
    },
  };
}
