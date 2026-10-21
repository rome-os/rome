import type { NodeThisDevice } from "@rome-os/node-ui";
import { useEffect, useState } from "react";
import { desktopDevice, type DesktopDeviceStatus } from "@/lib/electron-shell";

/**
 * The Mac app's computer and its switch, when the dashboard runs inside the app. Null in a
 * browser, in the private VM, or while the app is signed out, because the app answers only the
 * Rome it opened from Rome Cloud.
 *
 * `onChange` runs after the app applied a change, so the host can read the devices again.
 */
export function useThisDevice(onChange?: () => void): NodeThisDevice | null {
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
      .catch(() => undefined);
    const unsubscribe = bridge.onStatus(setStatus);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  if (!bridge || !status || status.state === "off") return null;
  return {
    id: status.deviceId,
    name: status.name,
    platform: "macos",
    state: status.state,
    busy,
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
