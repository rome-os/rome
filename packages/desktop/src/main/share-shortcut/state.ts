import { z } from "zod";
import type { SettingsAccess } from "../app-shims/store";

/** The one key that sends the selection to the chosen app, in Electron's accelerator syntax. */
export const SHARE_SHORTCUT_ACCELERATOR = "Alt+D";
/** The same key as macOS prints it. */
export const SHARE_SHORTCUT_LABEL = "⌥D";

/** The settings key holding the app the shortcut opens. */
export const SHARE_SHORTCUT_KEY = "shareShortcut.app";

export const SHARE_PANEL_DEFAULT_SIZE = { width: 420, height: 560 };
/** The sizes an app may ask for, as core's SHARE_PANEL_LIMITS. */
export const SHARE_PANEL_LIMITS = {
  width: { min: 280, max: 720 },
  height: { min: 200, max: 900 },
} as const;

// A URL carries the text, and servers refuse very long ones. A selection this
// long is a passage, which no quick lookup needs whole.
export const MAX_SHARED_TEXT = 2000;
// The cap on the text once percent-encoded. A CJK character takes nine bytes
// there, so 2,000 of them would pass Node's 16 KiB header limit (HTTP 431);
// this leaves room for the rest of the request.
export const MAX_ENCODED_TEXT = 6000;

/** The longest start of `text` within both caps, never splitting a character. */
export function clipSharedText(text: string): string {
  const chars = Array.from(text).slice(0, MAX_SHARED_TEXT);
  let encoded = 0;
  let end = 0;
  for (const char of chars) {
    encoded += encodeURIComponent(char).length;
    if (encoded > MAX_ENCODED_TEXT) break;
    end += 1;
  }
  return chars.slice(0, end).join("");
}

const recordSchema = z.object({
  appId: z.string().min(1),
  name: z.string().min(1),
  /** The app page that takes the text, on the Rome the app came from. */
  url: z.string().url(),
  /** The query parameter the page reads the text from. */
  param: z.string().min(1),
  /** The window size the app's share page is designed for, in points. */
  width: z.number().optional(),
  height: z.number().optional(),
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
  const trimmed = text ? clipSharedText(text.trim()) : "";
  if (trimmed) url.searchParams.set(app.param, trimmed);
  return url.toString();
}

const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.round(Math.min(max, Math.max(min, value)));

/**
 * The size the panel opens at: the app's own, within the limits, else the
 * default; never larger than the display's work area.
 */
export function panelSize(
  app: Pick<ShareShortcutApp, "width" | "height">,
  workArea: { width: number; height: number },
): { width: number; height: number } {
  const width = clamp(app.width ?? SHARE_PANEL_DEFAULT_SIZE.width, SHARE_PANEL_LIMITS.width);
  const height = clamp(app.height ?? SHARE_PANEL_DEFAULT_SIZE.height, SHARE_PANEL_LIMITS.height);
  return { width: Math.min(width, workArea.width), height: Math.min(height, workArea.height) };
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
