import type { GatewayNotification } from "@rome-os/node-core/host";
import { createLogger } from "./logger";

const log = createLogger("notifications");

/** The part of a BrowserWindow this module uses. */
export interface NotifiableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  webContents: {
    getURL(): string;
    executeJavaScript(code: string): Promise<unknown>;
  };
  loadURL(url: string): Promise<void>;
}

/** The part of an Electron Notification this module uses. */
export interface NativeNotification {
  on(event: "click" | "close", listener: () => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
  show(): void;
}

export interface NotificationDeps {
  /** The user's choice to show notifications. Off, they are received and dropped. */
  enabled(): boolean;
  /** The main Rome window, or null when none exists. */
  mainWindow(): NotifiableWindow | null;
  /** The Rome the app has open, or null while it has none. */
  openInstance(): { id: string; origin: string } | null;
  /** Shows and focuses the main window, restoring or creating it as needed. */
  showMainWindow(): Promise<NotifiableWindow | null>;
  createNotification(options: { title: string; body: string; silent: boolean }): NativeNotification;
}

const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The signed-in person's main Concierge chat (`MAIN_CHAT_PATH` in the web app). */
const MAIN_CHAT_PATH = "/message";

/** Shown notifications stay referenced until they end, or Electron may drop them before a click. */
const live = new Set<NativeNotification>();
let failureLogged = false;

/** Tests only: forget that a failure was logged. */
export function resetFailureLogForTests(): void {
  failureLogged = false;
}

/**
 * Where a click should open, on the instance the notification is about. No chat means the main
 * chat. A chat id that is not a plain id gets no path: the window is shown and nothing more.
 */
export function chatPathFor(chatId: string | undefined): string | null {
  if (chatId === undefined) return MAIN_CHAT_PATH;
  return CHAT_ID.test(chatId) ? `/chat/${chatId}` : null;
}

async function openPath(window: NotifiableWindow, origin: string, path: string): Promise<void> {
  const url = `${origin}${path}`;
  if (window.webContents.getURL().startsWith(`${origin}/`)) {
    try {
      // The page's host navigation event is a soft navigation: no reload, no lost state.
      await window.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent("rome:host-navigate",{detail:{path:${JSON.stringify(path)}}}))`,
      );
      return;
    } catch {
      // Fall through to a full load.
    }
  }
  await window.loadURL(url);
}

async function onClick(n: GatewayNotification, deps: NotificationDeps): Promise<void> {
  const window = await deps.showMainWindow();
  const instance = deps.openInstance();
  if (!window || window.isDestroyed() || !instance || instance.id !== n.instanceId) return;
  const path = chatPathFor(n.chatId);
  if (!path) return;
  try {
    await openPath(window, instance.origin, path);
  } catch (err) {
    log.warn(`Opening the chat from a notification failed (${String(err)})`);
  }
}

/**
 * Shows a notification Rome Cloud sent over the device Gateway, unless the user turned
 * notifications off or the Rome window is in front. No level means silent. The body is never logged.
 */
export function showDesktopNotification(n: GatewayNotification, deps: NotificationDeps): void {
  if (!deps.enabled()) {
    log.info("Desktop notification dropped: notifications are turned off in the app");
    return;
  }
  const window = deps.mainWindow();
  if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) {
    log.info("Desktop notification skipped: the Rome window is in front");
    return;
  }
  const notification = deps.createNotification({
    title: n.title,
    body: n.body,
    silent: n.level !== "active",
  });
  live.add(notification);
  notification.on("click", () => {
    live.delete(notification);
    void onClick(n, deps).catch((err) => {
      log.warn(`Opening Rome from a notification failed (${String(err)})`);
    });
  });
  notification.on("close", () => {
    live.delete(notification);
  });
  // macOS refuses notifications from an unsigned app. Say so once; there is no retry.
  notification.on("failed", (_event, error) => {
    live.delete(notification);
    if (failureLogged) return;
    failureLogged = true;
    log.warn(`The system did not show desktop notifications (${String(error)})`);
  });
  notification.show();
  log.info("Desktop notification shown");
}
