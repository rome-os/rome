import { ipcMain, type IpcMainInvokeEvent } from "electron";

/**
 * Whether an IPC call comes from one of the app's own pages (settings,
 * onboarding, pill), which load from `file:`. The main window also shows the
 * dashboard, which may be a Rome on the internet, and OAuth pages; those reach
 * the preload too, but must not drive the app.
 */
export function isTrustedSender(event: Pick<IpcMainInvokeEvent, "senderFrame">): boolean {
  const url = event.senderFrame?.url;
  if (!url) return false;
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

/** `ipcMain.handle` for channels only the app's own pages may call. */
export function handleTrusted(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error(`${channel} is not available to this page`);
    return handler(event, ...args);
  });
}

/**
 * Whether a call comes from the top frame of the Rome this launch opened. Its
 * dashboard shows and changes whether this computer is a device; other pages
 * in the main window, such as sign-in or checkout, never reach it.
 */
export function isInstanceSender(
  event: { senderFrame: { url: string; parent: unknown } | null },
  instanceOrigin: string | null,
): boolean {
  const frame = event.senderFrame;
  if (!frame || !instanceOrigin || frame.parent !== null) return false;
  try {
    return new URL(frame.url).origin === instanceOrigin;
  } catch {
    return false;
  }
}

/** `ipcMain.handle` for channels the app's own pages and the open Rome may call. */
export function handleFromAppOrInstance(
  channel: string,
  instanceOrigin: () => string | null,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event) && !isInstanceSender(event, instanceOrigin())) {
      throw new Error(`${channel} is not available to this page`);
    }
    return handler(event, ...args);
  });
}
