import { Card } from "@rome-os/ui/card";
import { Switch } from "@rome-os/ui/switch";
import { platformOf } from "./format.js";
import { messagesFor } from "./messages.js";
import { DeviceIcon } from "./parts.js";

/** This computer as a device, as the app that runs it reports it. */
export type NodeThisDeviceState = "connected" | "connecting" | "offline" | "disabled";

export interface NodeThisDeviceProps {
  name: string;
  /** `macos`, `linux`, `windows`, or another platform name. Picks the icon. */
  platform?: string | null;
  state: NodeThisDeviceState;
  /** True while a change the user asked for is applied. */
  busy?: boolean;
  onEnabledChange(enabled: boolean): void;
  /** BCP 47 tag for text. Chinese for `zh*`, English otherwise. */
  locale?: string;
}

/**
 * The computer the host page runs on, with a switch that lets the account's Rome use it or not.
 * Only a host that runs inside the app connecting the computer, such as the Mac app, mounts it.
 */
export function NodeThisDevice({
  name,
  platform,
  state,
  busy,
  onEnabledChange,
  locale,
}: NodeThisDeviceProps) {
  const m = messagesFor(locale).thisDevice;
  const enabled = state !== "disabled";
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 p-4">
        <DeviceIcon
          platform={platform}
          status={state === "connected" ? "connected" : "not_connected"}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-aux text-muted-foreground">{m.label}</span>
          <span className="block truncate text-ui font-medium text-foreground">{name}</span>
          <span className="block truncate font-mono text-aux text-muted-foreground">
            {[platformOf(platform).label, m.state[state]].filter(Boolean).join(" · ")}
          </span>
        </span>
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={(checked) => onEnabledChange(checked)}
          aria-label={m.toggle}
        />
      </div>
      <p className="border-t border-border px-4 py-3 text-aux text-muted-foreground">
        {enabled ? m.on : m.off}
      </p>
    </Card>
  );
}
