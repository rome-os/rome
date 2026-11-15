import { useTranslation } from "react-i18next";

/**
 * A device's connect card once it is answered: one line saying whether the
 * capability got connected, with no buttons, since the device's app ran the
 * flow and nothing is left to press.
 */
export function DeviceConnectSettled({ result }: { result: Record<string, unknown> }) {
  const { t } = useTranslation("chat");
  const connected = result.status === "connected";
  return (
    <div className="flex w-full max-w-md rounded-16 border border-border bg-surface px-4 py-3">
      <span className={connected ? "text-ui text-foreground" : "text-ui text-muted-foreground"}>
        {t(connected ? "deviceConnectCard.connected" : "deviceConnectCard.notConnected")}
      </span>
    </div>
  );
}

/** Whether a pending interaction is core's connect card for a device kind. */
export function isDeviceConnectCard(block: {
  appId?: string;
  render: { componentId?: string; props?: unknown };
}): boolean {
  const props = block.render.props as { device?: unknown } | undefined;
  return (
    block.appId === "core" && block.render.componentId === "connect-card" && props?.device === true
  );
}
