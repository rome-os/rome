import { z } from "zod";
import type { SettingsAccess } from "../app-shims/store";

/** The one key that sends the selection to the chosen app, in Electron's accelerator syntax. */
export const SHARE_SHORTCUT_ACCELERATOR = "Alt+D";
/** The same key as macOS prints it. */
export const SHARE_SHORTCUT_LABEL = "⌥D";

/** The settings key holding the app the shortcut opens. */
export const SHARE_SHORTCUT_KEY = "shareShortcut.app";

export const SHARE_PANEL_DEFAULT_SIZE = { width: 420, height: 560 };

// A URL carries the text, and servers refuse very long ones. A selection this
// long is a passage, which no quick lookup needs whole.
export const MAX_SHARED_TEXT = 2000;

const recordSchema = z.object({
  appId: z.string().min(1),
  name: z.string().min(1),
  /** The app page that takes the text, on the Rome the app came from. */
  url: z.string().url(),
  /** The query parameter the page reads the text from. */
  param: z.string().min(1),
});

export type ShareShortcutApp = z.infer<typeof recordSchema>;

/** The saved app, or null when none is chosen or the value is unreadable. */
export function readShareShortcutApp(settings: SettingsAccess): ShareShortcutApp | null {
  const raw = settings.read(SHARE_SHORTCUT_KEY);
  if (!raw) return null;
  try {
    const record = recordSchema.safeParse(JSON.parse(raw));
    return record.success ? record.data : null;
  } catch {
    return null;
  }
}

/** The page to open for `text`: the app's own page, with the text when there is any. */
export function shareUrl(
  app: Pick<ShareShortcutApp, "url" | "param">,
  text: string | null,
): string {
  const url = new URL(app.url);
  const trimmed = text?.trim().slice(0, MAX_SHARED_TEXT);
  if (trimmed) url.searchParams.set(app.param, trimmed);
  return url.toString();
}

interface Point {
  x: number;
  y: number;
}
interface Size {
  width: number;
  height: number;
}

const CURSOR_GAP = 16;

/**
 * Where the panel opens: just below and right of the pointer, which is where
 * the user was reading, kept whole inside that display's work area.
 */
export function panelPosition(cursor: Point, size: Size, workArea: Point & Size): Point {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: Math.round(Math.max(workArea.x, Math.min(cursor.x + CURSOR_GAP, maxX))),
    y: Math.round(Math.max(workArea.y, Math.min(cursor.y + CURSOR_GAP, maxY))),
  };
}
