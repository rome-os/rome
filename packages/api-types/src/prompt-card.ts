// The cards that ask the guardian to let Rome reach something, described as
// data: connecting a device's capability, sharing the location. One builder,
// so they read as one family on every reader: an icon on the title, a quiet
// line under it, then Not now and the action. Each card fills in its own
// words and events.

import type { WidgetUi, WidgetUiIcon, WidgetUiString } from "@rome-os/app-runtime";

type EventContext = Record<string, string | number | boolean>;

export interface PromptCardButton {
  label: WidgetUiString;
  /** The event the button fires. */
  event: string;
  context?: EventContext;
}

export interface PromptCard {
  /** A glyph from `WIDGET_UI_ICONS` before the title; none when left out. */
  icon?: WidgetUiIcon;
  title: WidgetUiString;
  /** The quiet line under the title: what it is for, or the agent's reason. */
  note: WidgetUiString;
  dismiss: PromptCardButton;
  confirm: PromptCardButton;
  /** The card's data model, such as the location card's `autoShare`. */
  data?: Record<string, unknown>;
}

export function promptCardUi(card: PromptCard): WidgetUi {
  const action = (button: PromptCardButton) => ({
    event: { name: button.event, ...(button.context ? { context: button.context } : {}) },
  });
  return {
    ...(card.data ? { data: card.data } : {}),
    components: [
      { id: "root", component: "Column", children: ["title", "note", "actions"] },
      {
        id: "title",
        component: "Text",
        text: card.title,
        variant: "h4",
        ...(card.icon ? { icon: card.icon } : {}),
      },
      { id: "note", component: "Text", text: card.note, variant: "caption" },
      { id: "actions", component: "Row", children: ["dismiss", "confirm"], justify: "end" },
      {
        id: "dismiss",
        component: "Button",
        child: "dismiss-label",
        variant: "default",
        action: action(card.dismiss),
      },
      { id: "dismiss-label", component: "Text", text: card.dismiss.label },
      {
        id: "confirm",
        component: "Button",
        child: "confirm-label",
        variant: "primary",
        action: action(card.confirm),
      },
      { id: "confirm-label", component: "Text", text: card.confirm.label },
    ],
  };
}
