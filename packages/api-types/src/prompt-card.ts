// The cards that ask the guardian to let Rome reach something, described as
// data: connecting a device's capability, sharing the location. One builder,
// so they read as one family on every reader: an icon on the title, a quiet
// line under it, then Not now and the action. Each card fills in its own
// words and events.

import type {
  WidgetUi,
  WidgetUiIcon,
  WidgetUiString,
  WidgetUiStringName,
} from "@rome-os/app-runtime";

/**
 * Where a card keeps Rome's own words with their English, in its data model:
 * `/romeStrings/<name>`. A reader that knows the name puts the guardian's
 * language there before it draws; an older one, which does not, draws the
 * English. A `{ string }` it did not know drew nothing.
 */
export const ROME_STRINGS_KEY = "romeStrings";

/** One of Rome's own words, with the English an older reader shows. */
export interface RomeWord {
  rome: WidgetUiStringName;
  english: string;
}

type EventContext = Record<string, string | number | boolean>;

export interface PromptCardButton {
  label: WidgetUiString | RomeWord;
  /** The event the button fires. */
  event: string;
  context?: EventContext;
}

export interface PromptCard {
  /** A glyph from `WIDGET_UI_ICONS` before the title; none when left out. */
  icon?: WidgetUiIcon;
  title: WidgetUiString | RomeWord;
  /** The quiet line under the title: what it is for, or the agent's reason. */
  note: WidgetUiString | RomeWord;
  dismiss: PromptCardButton;
  confirm: PromptCardButton;
  /** The card's data model, such as the location card's `autoShare`. */
  data?: Record<string, unknown>;
}

export function promptCardUi(card: PromptCard): WidgetUi {
  const action = (button: PromptCardButton) => ({
    event: { name: button.event, ...(button.context ? { context: button.context } : {}) },
  });
  const words: Record<string, string> = {};
  const text = (value: WidgetUiString | RomeWord): WidgetUiString => {
    if (typeof value !== "object" || !("rome" in value)) return value;
    words[value.rome] = value.english;
    return { path: `/${ROME_STRINGS_KEY}/${value.rome}` };
  };
  const title = text(card.title);
  const note = text(card.note);
  const dismiss = text(card.dismiss.label);
  const confirm = text(card.confirm.label);
  const data = {
    ...(card.data ?? {}),
    ...(Object.keys(words).length > 0 ? { [ROME_STRINGS_KEY]: words } : {}),
  };
  return {
    ...(Object.keys(data).length > 0 ? { data } : {}),
    components: [
      { id: "root", component: "Column", children: ["title", "note", "actions"] },
      {
        id: "title",
        component: "Text",
        text: title,
        variant: "h4",
        ...(card.icon ? { icon: card.icon } : {}),
      },
      { id: "note", component: "Text", text: note, variant: "caption" },
      { id: "actions", component: "Row", children: ["dismiss", "confirm"], justify: "end" },
      {
        id: "dismiss",
        component: "Button",
        child: "dismiss-label",
        variant: "default",
        action: action(card.dismiss),
      },
      { id: "dismiss-label", component: "Text", text: dismiss },
      {
        id: "confirm",
        component: "Button",
        child: "confirm-label",
        variant: "primary",
        action: action(card.confirm),
      },
      { id: "confirm-label", component: "Text", text: confirm },
    ],
  };
}
