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
