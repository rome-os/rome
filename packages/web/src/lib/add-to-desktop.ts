import type { TFunction } from "i18next";
import { toast } from "sonner";
import type { DesktopAppsBridge } from "@/lib/electron-shell";

/**
 * Puts a Rome app on this Mac's Desktop through the Mac app, and says how it
 * went. Every menu that offers "Add to Desktop" uses this.
 */
export function addAppToDesktop(
  desktop: DesktopAppsBridge,
  app: { id: string; displayName: string },
  t: TFunction<"apps">,
): void {
  desktop.addToDesktop(app.id).then(
    () => toast.success(t("installed.addedToDesktop", { name: app.displayName })),
    () => toast.error(t("installed.addToDesktopFailed", { name: app.displayName })),
  );
}

/**
 * Makes the Mac app's share shortcut open a Rome app, and says how to use it.
 * Only apps that take shared text (`acceptsSharedText`) offer this.
 */
export function assignShareShortcut(
  assign: (appId: string) => Promise<{ shortcut: string }>,
  app: { id: string; displayName: string },
  t: TFunction<"apps">,
): void {
  assign(app.id).then(
    ({ shortcut }) =>
      toast.success(t("installed.shareShortcutReady", { name: app.displayName, shortcut })),
    (err: unknown) =>
      toast.error(t("installed.shareShortcutFailed", { name: app.displayName }), {
        description: ipcErrorReason(err),
      }),
  );
}

// Electron wraps a main-process error as "Error invoking remote method
// '<channel>': Error: <reason>"; the reason is what the user can act on, such
// as the key being taken by another app.
function ipcErrorReason(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
