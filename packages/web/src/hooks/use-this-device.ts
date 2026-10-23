import type { NodeThisDevice } from "@rome-os/node-ui";
import { useEffect, useState } from "react";
import { desktopDevice, type DesktopDeviceStatus } from "@/lib/electron-shell";

/**
 * The Mac app's computer and its switch, when the dashboard runs inside the app. Null in a
 * browser, in the private VM, or while the app is signed out, because the app answers only the
 * Rome it opened from Rome Cloud. Undefined inside the app until it answers, which a page that
 * places this computer first waits for.
 *
 * `onChange` runs after the app applied a change, so the host can read the devices again.
 */
export function useThisDevice(onChange?: () => void): NodeThisDevice | null | undefined {
  const [bridge] = useState(desktopDevice);
  const [status, setStatus] = useState<DesktopDeviceStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge
      .get()
      .then((current) => {
        if (live) setStatus(current);
      })
      // An app that refuses this page has no computer to offer it.
      .catch(() => {
        if (live) setStatus({ state: "off" });
      });
    const unsubscribe = bridge.onStatus(setStatus);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  if (!bridge) return null;
  if (!status) return undefined;
  if (status.state === "off") return null;
  return {
    id: status.deviceId,
    name: status.name,
    platform: "macos",
    state: status.state,
    busy,
    removeUrl: `${import.meta.env.ROME_CLOUD_ORIGIN}/dashboard/settings`,
    onEnabledChange(enabled) {
      setBusy(true);
      bridge
        .setEnabled(enabled)
        .then((next) => {
          setStatus(next);
          onChange?.();
        })
        .catch(() => undefined)
        .finally(() => setBusy(false));
    },
  };
}
