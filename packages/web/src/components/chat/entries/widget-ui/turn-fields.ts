import { createContext } from "react";
import type { WidgetEventOutcome } from "@/lib/chat-api";

/** What the view a widget is drawn in gives it. */
export interface WidgetHost {
  /** A view that only shows a chat, such as a shared snapshot or the session
   *  viewer: its widgets send no events. */
  readOnly?: boolean;
  /**
   * The turn fields (persona, reasoning effort, workspace) of the chat the
   * widget is in, which it sends with every event. Core uses them only when
   * the event starts a turn, so the answer runs as a message typed there would.
   */
  turnFields: () => Record<string, unknown>;
  /** Hears what core said to an event, so the view can read the chat again:
   *  a turn the event started may finish before the view sees it run. */
  onSettled?: (outcome: WidgetEventOutcome) => void;
}

export const WidgetHostContext = createContext<WidgetHost>({ turnFields: () => ({}) });

/** The host of a view that only shows a chat. */
export const READ_ONLY_WIDGET_HOST: WidgetHost = { readOnly: true, turnFields: () => ({}) };
