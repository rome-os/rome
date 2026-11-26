import { app, BrowserWindow, globalShortcut, net, screen, shell } from "electron";
import { type AppIdentity, fetchAppIdentity } from "../app-shims/identity";
import type { SettingsAccess } from "../app-shims/store";
import { isQuitting } from "../lifecycle";
import { createLogger } from "../logger";
import { readSelectedText } from "./selection";
import {
  panelPosition,
  readShareShortcutApp,
  panelSize,
  SHARE_PANEL_LIMITS,
  SHARE_SHORTCUT_ACCELERATOR,
  SHARE_SHORTCUT_KEY,
  SHARE_SHORTCUT_LABEL,
  shareUrl,
  type ShareShortcutApp,
} from "./state";

const log = createLogger("share-shortcut");

export interface ShareShortcut {
  /** The app the shortcut opens, or null when none is chosen. */
  current(): ShareShortcutApp | null;
  /** Makes the shortcut open `appId` of `origin`, which must take shared text. */
  use(origin: string, appId: string): Promise<ShareShortcutApp>;
  /** Opens the chosen app's panel as the shortcut would, without a selection. */
  open(): void;
  /** Turns the shortcut off. */
  clear(): void;
  /** One consumer (the tray); a second call replaces the first. */
  onChange(callback: () => void): void;
}

/**
 * The share shortcut: a key that reads the selection in any app and opens a
 * Rome app that takes shared text in a floating panel beside the pointer, with
 * that text. Which app is the user's choice, from the app's menu in Rome; any
 * app that declares `web.shareTarget` can be the one.
 */
/** The saved form of an app's share target, or null when the app takes no text. */
function toRecord(appId: string, identity: AppIdentity): ShareShortcutApp | null {
  if (!identity.shareTarget) return null;
  return {
    appId,
    name: identity.name,
    url: identity.shareTarget.url,
    param: identity.shareTarget.param,
    width: identity.shareTarget.width,
    height: identity.shareTarget.height,
  };
}

export function setupShareShortcut(
  settings: SettingsAccess,
  /** Resolves once the Rome is reachable and its session is in place. */
  whenReady: () => Promise<void>,
): ShareShortcut {
  let panel: BrowserWindow | null = null;
  let loadedUrl: string | null = null;
  let changed: (() => void) | null = null;
  let pressing = false;

  const current = (): ShareShortcutApp | null => readShareShortcutApp(settings);

  // Closing the panel hands the keyboard back to the app the user came from,
  // unless Rome has a window of its own in view to go back to.
  const dismiss = (): void => {
    if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
    const wasFocused = panel.isFocused();
    panel.hide();
    const otherVisible = BrowserWindow.getAllWindows().some(
      (w) => w !== panel && !w.isDestroyed() && w.isVisible(),
    );
    if (wasFocused && !otherVisible) app.hide();
  };

  const clear = (): void => {
    unregister();
    settings.write(SHARE_SHORTCUT_KEY, "");
    if (panel && !panel.isDestroyed()) panel.destroy();
    changed?.();
  };

  // The saved app is a copy of its share target when it was chosen. An update
  // can move or resize the page, or drop it, so the copy is read again once
  // the Rome is reachable and whenever a new panel is made. A failed read keeps
  // the copy.
  const refresh = async (): Promise<void> => {
    const saved = current();
    if (!saved) return;
    try {
      await whenReady();
      const identity = await fetchAppIdentity(
        (url) => net.fetch(url),
        new URL(saved.url).origin,
        saved.appId,
      );
      // The user chose another app while this was reading.
      if (current()?.appId !== saved.appId) return;
      const record = toRecord(saved.appId, identity);
      if (!record) {
        log.info(`${identity.name} no longer takes shared text, so ${SHARE_SHORTCUT_LABEL} is off`);
        clear();
        return;
      }
      if (JSON.stringify(record) === JSON.stringify(saved)) return;
      settings.write(SHARE_SHORTCUT_KEY, JSON.stringify(record));
      changed?.();
    } catch (err) {
      log.warn(`Could not refresh ${saved.name}'s share target (${String(err)})`);
    }
  };

  const ensurePanel = (target: ShareShortcutApp): BrowserWindow => {
    if (panel && !panel.isDestroyed()) {
      panel.setTitle(target.name);
      return panel;
    }
    void refresh();
    const created = new BrowserWindow({
      ...panelSize(target, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea),
      minWidth: SHARE_PANEL_LIMITS.width.min,
      minHeight: SHARE_PANEL_LIMITS.height.min,
      title: target.name,
      // An NSPanel floats over the app the user is reading in, and showing it
      // inactive leaves that app in front: the answer needs no focus to read.
      type: "panel",
      alwaysOnTop: true,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    // Follows the user to the Space, and the full-screen app, they press the
    // key in. Skipping the process-type change keeps Rome's Dock icon.
    created.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    // As in the main window: a new window is a link out, for the system browser.
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    created.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    });
    // Kept rather than closed, so the next press opens at once.
    created.on("close", (event) => {
      if (isQuitting()) return;
      event.preventDefault();
      dismiss();
    });
    created.on("closed", () => {
      if (panel === created) {
        panel = null;
        loadedUrl = null;
      }
    });
    panel = created;
    return created;
  };

  const show = (target: ShareShortcutApp, text: string | null): void => {
    const win = ensurePanel(target);
    if (!win.isVisible()) {
      const cursor = screen.getCursorScreenPoint();
      const workArea = screen.getDisplayNearestPoint(cursor).workArea;
      const [width, height] = win.getSize();
      const { x, y } = panelPosition(cursor, { width, height }, workArea);
      win.setPosition(x, y);
    }
    // A press with nothing selected reopens the page as it was left.
    const url = shareUrl(target, text);
    if (text || loadedUrl === null || !loadedUrl.startsWith(target.url)) {
      loadedUrl = url;
      // As for apps on the Desktop: a press right after launch waits for the
      // Rome, so the page does not land on a sign-in it can't complete.
      void whenReady()
        .then(() => (win.isDestroyed() || loadedUrl !== url ? undefined : win.loadURL(url)))
        .catch((err: unknown) => {
          log.warn(`${target.name} did not load (${String(err)})`);
          // The next press loads again rather than keeping the failed page.
          if (loadedUrl === url) loadedUrl = null;
        });
    }
    win.showInactive();
  };

  const onPress = async (): Promise<void> => {
    const target = current();
    // A key held down repeats; one press is handled at a time.
    if (!target || pressing) return;
    pressing = true;
    try {
      const text = await readSelectedText();
      // The same key closes an open panel when nothing new is selected. The
      // app the user reads in keeps its selection, so the same text counts.
      const open = panel !== null && !panel.isDestroyed() && panel.isVisible();
      if (open && (!text || shareUrl(target, text) === loadedUrl)) {
        dismiss();
        return;
      }
      show(target, text);
    } finally {
      pressing = false;
    }
  };

  const register = (): void => {
    if (globalShortcut.isRegistered(SHARE_SHORTCUT_ACCELERATOR)) return;
    const ok = globalShortcut.register(SHARE_SHORTCUT_ACCELERATOR, () => {
      void onPress();
    });
    if (!ok) {
      throw new Error(`${SHARE_SHORTCUT_ACCELERATOR} is already used by another app.`);
    }
  };

  const unregister = (): void => {
    if (globalShortcut.isRegistered(SHARE_SHORTCUT_ACCELERATOR)) {
      globalShortcut.unregister(SHARE_SHORTCUT_ACCELERATOR);
    }
  };

  if (current()) {
    try {
      register();
    } catch (err) {
      log.warn(String(err));
    }
    void refresh();
  }
  app.on("will-quit", unregister);

  return {
    current,
    use: async (origin, appId) => {
      const identity = await fetchAppIdentity((url) => net.fetch(url), origin, appId);
      const record = toRecord(appId, identity);
      if (!record) throw new Error(`${identity.name} doesn't take shared text.`);
      register();
      settings.write(SHARE_SHORTCUT_KEY, JSON.stringify(record));
      // A panel still showing the previous app would answer the next press.
      if (panel && !panel.isDestroyed()) panel.destroy();
      changed?.();
      log.info(`${SHARE_SHORTCUT_ACCELERATOR} now opens ${identity.name}`);
      return record;
    },
    open: () => {
      const target = current();
      if (target) show(target, null);
    },
    clear,
    onChange: (callback) => {
      changed = callback;
    },
  };
}
