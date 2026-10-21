import { NodeThisDevice, type NodeDevice } from "@rome-os/node-ui";
import { useEffect, useState } from "react";
import { desktopDevice, type DesktopDeviceStatus } from "@/lib/electron-shell";

/**
 * The Mac app's computer, with its switch, when the dashboard runs inside the app. Renders
 * nothing in a browser, in the private VM, or while the app is signed out, because the app
 * answers only the Rome it opened from Rome Cloud.
 */
export function ThisDeviceCard({
  devices,
  locale,
  onChange,
}: {
  /** The account's devices, for the name and platform Rome Cloud keeps for this computer. */
  devices: NodeDevice[];
  locale?: string;
  /** Called after the app applied a change, so the host can read the devices again. */
  onChange?: () => void;
}) {
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
  const listed = devices.find((device) => device.id === status.deviceId);

  return (
    <NodeThisDevice
      name={listed?.name ?? status.name}
      platform={listed?.platform ?? "macos"}
      state={status.state}
      busy={busy}
      locale={locale}
      onEnabledChange={(enabled) => {
        setBusy(true);
        bridge
          .setEnabled(enabled)
          .then((next) => {
            setStatus(next);
            onChange?.();
          })
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    />
  );
}
