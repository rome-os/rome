import path from "path";
import { app, BrowserWindow, ipcMain, Menu, screen, session } from "electron";
import { eq } from "drizzle-orm";
import { getDb } from "./db/database";
import { settings } from "./db/schema";
import {
  clampPillPosition,
  defaultPillPosition,
  isPillEnabled,
  parseAgentName,
  parsePillPosition,
  PILL_DEFAULT_HEIGHT,
  PILL_DEFAULT_WIDTH,
  PILL_ENABLED_KEY,
  PILL_FALLBACK_NAME,
  PILL_POSITION_KEY,
  type Point,
  type Size,
} from "./floating-pill-state";
import { isQuitting, requestStopAndQuit } from "./lifecycle";
import { createLogger } from "./logger";
import type { RuntimeManager, RuntimeStatus } from "./runtime/manager";

const log = createLogger("pill");

const PRELOAD_PATH = path.join(__dirname, "..", "preload", "index.js");
const PILL_HTML = path.join(__dirname, "..", "..", "src", "renderer", "pill.html");

export interface FloatingPillOptions {
  showMainWindow: () => void | Promise<void>;
  openSettings: () => void;
  runtimeManager: RuntimeManager;
}

export interface FloatingPill {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  /** One consumer (the tray); a second call replaces the first. */
  onEnabledChange(callback: () => void): void;
}

function readSetting(key: string): string | null {
  try {
    const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
    return row?.value ?? null;
  } catch (err) {
    log.warn(`Failed to read ${key} (${String(err)})`);
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  try {
    getDb()
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  } catch (err) {
    log.warn(`Failed to write ${key} (${String(err)})`);
  }
}

export function setupFloatingPill(options: FloatingPillOptions): FloatingPill {
  const { showMainWindow, openSettings, runtimeManager } = options;

  let win: BrowserWindow | null = null;
  let name = PILL_FALLBACK_NAME;
  let size: Size = { width: PILL_DEFAULT_WIDTH, height: PILL_DEFAULT_HEIGHT };
  let dragOffset: Point | null = null;
  let enabledChanged: (() => void) | null = null;

  const workAreaAt = (point: Point): Electron.Rectangle =>
    screen.getDisplayNearestPoint(point).workArea;

  // The main window loads the same preload and navigates to other origins
  // (provider sign-in, checkout), so window.rome.pill exists on those pages
  // too. Only the icon's own page may move this window or open its menu.
  const fromPill = (event: Electron.IpcMainEvent): boolean =>
    win !== null && !win.isDestroyed() && event.sender === win.webContents;

  const clampIntoView = (): Point | null => {
    if (!win || win.isDestroyed()) return null;
    const [x, y] = win.getPosition();
    const position = clampPillPosition({ x, y }, size, workAreaAt({ x, y }));
    win.setPosition(position.x, position.y);
    return position;
  };

  // Electron 36 has no app.isActive(), so the state is kept from the two
  // activation events. By the time this runs the main window has loaded, so a
  // focused window means Rome is in front; if this guess is ever wrong, the
  // next app switch corrects it.
  let romeActive = BrowserWindow.getFocusedWindow() !== null;

  // The pill is the way back to Rome, so it has no job while Rome is in front —
  // and staying hidden then keeps it off Rome's own UI.
  const syncVisibility = (): void => {
    if (!win || win.isDestroyed() || isQuitting()) return;
    if (romeActive) win.hide();
    else win.showInactive();
  };

  const createWindow = (revealOnce = false): void => {
    if (win && !win.isDestroyed()) return;

    const saved = parsePillPosition(readSetting(PILL_POSITION_KEY));
    const workArea = saved ? workAreaAt(saved) : screen.getPrimaryDisplay().workArea;
    const position = clampPillPosition(
      saved ?? defaultPillPosition(workArea, size),
      size,
      workArea,
    );

    const created = new BrowserWindow({
      ...position,
      ...size,
      // An NSPanel: clicking it does not activate Rome, so the app the user is
      // working in stays in front until they actually ask for the main window.
      type: "panel",
      // A panel can still become the key window, and then the user's keystrokes
      // go to the pill after a drag instead of back to their editor.
      focusable: false,
      // A window that is never key is always receiving a "first" click, which
      // AppKit otherwise swallows.
      acceptFirstMouse: true,
      title: "Rome Floating Icon",
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    win = created;

    created.on("closed", () => {
      if (win === created) win = null;
    });
    created.once("ready-to-show", () => {
      // Ticked in the tray while Rome is frontmost, the icon would be hidden the
      // moment it exists, and the tick would look like it did nothing. Show it
      // this once; the next time Rome becomes active hides it as usual.
      if (revealOnce && !created.isDestroyed() && !isQuitting()) created.showInactive();
      else syncVisibility();
    });

    void created.loadFile(PILL_HTML);
  };

  const refreshName = async (): Promise<void> => {
    // With the icon turned off there is nowhere to show a name.
    if (!win || win.isDestroyed() || !runtimeManager.isReady()) return;
    try {
      // The body is the guardian's whole settings map, connector secrets
      // included, and only agentName is read from it. It must never be logged.
      const response = await session.defaultSession.fetch(
        `${runtimeManager.getDashboardUrl()}/api/settings`,
        {
          // The route is behind the dashboard's session cookie. Electron sends
          // it by default only while the request carries no Origin header.
          credentials: "include",
          // This runs on every switch away from Rome; a runtime that has
          // stopped answering should not leave one request hanging per switch.
          signal: AbortSignal.timeout(5_000),
        },
      );
      // Signed out, or the runtime is mid-restart: keep the name we have
      // rather than flickering back to the fallback.
      if (!response.ok) return;
      const next = parseAgentName(await response.json()) ?? PILL_FALLBACK_NAME;
      if (next === name) return;
      name = next;
      if (win && !win.isDestroyed()) win.webContents.send("pill:name", name);
    } catch (err) {
      log.warn(`Failed to refresh the agent name (${String(err)})`);
    }
  };

  const isEnabled = (): boolean => isPillEnabled(readSetting(PILL_ENABLED_KEY));

  const setEnabled = (enabled: boolean): void => {
    writeSetting(PILL_ENABLED_KEY, enabled ? "true" : "false");
    if (enabled) {
      createWindow(true);
      void refreshName();
    } else if (win && !win.isDestroyed()) {
      win.destroy();
      win = null;
    }
    enabledChanged?.();
  };

  ipcMain.on("pill:ready", (event) => {
    if (!fromPill(event)) return;
    event.sender.send("pill:name", name);
  });

  // The page owns the icon's layout, so it reports the size the window has to
  // be: both dimensions, measured, rather than one of them restated here.
  ipcMain.on("pill:setSize", (event, rawWidth: number, rawHeight: number) => {
    if (!fromPill(event) || !win) return;
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) return;
    size = { width: Math.ceil(rawWidth), height: Math.ceil(rawHeight) };
    win.setSize(size.width, size.height);
    // A longer name widens the icon to the right, which can push it off-screen.
    clampIntoView();
  });

  ipcMain.on("pill:click", (event) => {
    if (!fromPill(event)) return;
    dragOffset = null;
    void showMainWindow();
  });

  // The window follows the real cursor rather than coordinates the page sends,
  // because the page's own coordinates shift under it as the window moves. The
  // one thing taken from the page is where inside the window the pointer went
  // down: the press can be delivered late, after the cursor has already moved
  // on, so the cursor's position at this moment says nothing about the grab.
  ipcMain.on("pill:dragStart", (event, grabX: number, grabY: number) => {
    if (!fromPill(event) || !Number.isFinite(grabX) || !Number.isFinite(grabY)) return;
    // The page reports fractional CSS pixels; setPosition takes whole points.
    dragOffset = { x: Math.round(grabX), y: Math.round(grabY) };
  });

  ipcMain.on("pill:dragMove", (event) => {
    if (!fromPill(event) || !win || !dragOffset) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
  });

  ipcMain.on("pill:dragEnd", (event) => {
    if (!fromPill(event) || !win) return;
    // A drag recognised only at the release never sent a move, so the window
    // has not followed yet.
    if (dragOffset) {
      const cursor = screen.getCursorScreenPoint();
      win.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
    }
    dragOffset = null;
    const position = clampIntoView();
    if (position) writeSetting(PILL_POSITION_KEY, JSON.stringify(position));
  });

  ipcMain.on("pill:contextMenu", (event) => {
    if (!fromPill(event) || !win) return;
    dragOffset = null;
    const stopping = isQuitting() || runtimeManager.getStatus().phase === "stopping";
    Menu.buildFromTemplate([
      { label: "Open Rome", click: () => void showMainWindow() },
      { type: "separator" },
      { label: "Settings…", click: openSettings },
      { label: "Hide floating icon", click: () => setEnabled(false) },
      { type: "separator" },
      // Same wording as the tray, which is the other place this quit lives.
      {
        label: stopping ? "Stopping agent…" : "Stop agent and quit",
        enabled: !stopping,
        click: () => requestStopAndQuit(),
      },
    ]).popup({ window: win });
  });

  runtimeManager.on("status", (status: RuntimeStatus) => {
    if (status.phase === "ready") void refreshName();
  });

  // App activation, not window focus: a sheet on the main window makes it
  // "main but not key", and the window-level events and getFocusedWindow()
  // then disagree, which would leave the pill on top of a focused Rome.
  // Sheets, file pickers, menus and switching between Rome's own windows never
  // change activation, and neither does clicking the pill, a non-activating
  // panel.
  app.on("did-become-active", () => {
    romeActive = true;
    syncVisibility();
  });
  app.on("did-resign-active", () => {
    romeActive = false;
    syncVisibility();
    // The name is set in onboarding and edited in the dashboard's settings,
    // both inside the main window. Leaving Rome is when the pill comes into
    // view, so that is when to re-read.
    void refreshName();
  });

  // A display unplugged or rearranged while Rome runs can leave the icon on a
  // screen that is gone. The stored position is left alone, so it returns to
  // its place when that display does.
  screen.on("display-removed", clampIntoView);
  screen.on("display-metrics-changed", clampIntoView);

  if (isEnabled()) createWindow();
  void refreshName();

  return {
    isEnabled,
    setEnabled,
    onEnabledChange: (callback) => {
      enabledChanged = callback;
    },
  };
}
