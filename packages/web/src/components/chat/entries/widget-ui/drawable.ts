import { checkWidgetUi } from "@rome/api-types/chat";

/**
 * Whether a stored card may be drawn and may call its app. A stored part is
 * read back as data, so the dashboard runs core's check again rather than
 * trust it: every component drawable, every path inside the app, and an app
 * id that stays one path segment once the browser normalizes the URL.
 */
export function isDrawableCard(appId: string, ui: unknown, bind: unknown, waits = false): boolean {
  if (!appId || appId === "." || appId === "..") return false;
  return checkWidgetUi(ui, bind ?? {}, { waits }).length === 0;
}
