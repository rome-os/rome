// The size the window opens at, before the page has measured itself and
// reported the real one. The page owns the layout; these only have to be close
// enough that the first frame does not jump far.
export const PILL_DEFAULT_WIDTH = 96;
export const PILL_DEFAULT_HEIGHT = 80;
export const PILL_EDGE_MARGIN = 24;
export const PILL_FALLBACK_NAME = "Rome";

export const PILL_ENABLED_KEY = "floatingPill.enabled";
export const PILL_POSITION_KEY = "floatingPill.position";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** The agent's name out of a `GET /api/settings` body, or null when unset. */
export function parseAgentName(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null) return null;
  const raw = (settings as Record<string, unknown>).agentName;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

// Opt-in: a permanent object on the desktop is the user's call, so the icon is
// off until they turn it on from the tray. Only an explicit "true" is on.
export function isPillEnabled(raw: string | null): boolean {
  return raw === "true";
}

// Far beyond any arrangement of displays, and far below what the window APIs
// can represent.
const MAX_COORDINATE = 100_000;

function isUsableCoordinate(value: unknown): value is number {
  return typeof value === "number" && Math.abs(value) <= MAX_COORDINATE;
}

/**
 * A stored position the window APIs will accept, or null. They throw on a
 * non-finite or out-of-range number, this runs during bootstrap, and bootstrap
 * quits on a throw — so an unusable value must read as "never stored" rather
 * than reach them.
 */
export function parsePillPosition(raw: string | null): Point | null {
  if (!raw) return null;
  try {
    const { x, y } = JSON.parse(raw) as Record<string, unknown>;
    if (!isUsableCoordinate(x) || !isUsableCoordinate(y)) return null;
    return { x: Math.round(x), y: Math.round(y) };
  } catch {
    return null;
  }
}

/**
 * Whether this system gets the floating icon.
 *
 * The icon depends on a panel that takes clicks without activating Rome. On
 * macOS 27 a click on a panel activates the app (electron/electron#53889), and
 * becoming active is what hides the icon — so it would vanish under the pointer
 * mid-gesture. Off there until that is fixed upstream or checked on a machine.
 * Darwin's major version runs one behind macOS's: Darwin 26 is macOS 27.
 */
export function supportsFloatingPill(platform: string, osRelease: string): boolean {
  if (platform !== "darwin") return false;
  const darwinMajor = Number.parseInt(osRelease, 10);
  return Number.isFinite(darwinMajor) && darwinMajor < 26;
}

export function defaultPillPosition(workArea: Rect, size: Size): Point {
  return {
    x: workArea.x + workArea.width - size.width - PILL_EDGE_MARGIN,
    y: workArea.y + workArea.height - size.height - PILL_EDGE_MARGIN,
  };
}

/**
 * Keep the whole pill inside a display's work area. AppKit does not constrain
 * borderless windows, so without this a drag can leave the pill under the menu
 * bar, and undocking a laptop can leave it on a display that is gone.
 */
export function clampPillPosition(position: Point, size: Size, workArea: Rect): Point {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: Math.max(workArea.x, Math.min(position.x, maxX)),
    y: Math.max(workArea.y, Math.min(position.y, maxY)),
  };
}
