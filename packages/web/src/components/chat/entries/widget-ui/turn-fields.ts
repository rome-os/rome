import { createContext } from "react";

/**
 * The chat's own turn fields (persona, reasoning effort, workspace), which a
 * widget sends with every event. Core uses them only when the event starts a
 * turn, so the answer runs as a message typed in this chat would.
 */
export const WidgetTurnFieldsContext = createContext<() => Record<string, unknown>>(() => ({}));
