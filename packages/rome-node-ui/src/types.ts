export type NodeDeviceStatus = "connected" | "not_connected" | "unknown" | "revoked";

/** A device linked to the account, as the host reads it from Rome Cloud. */
export interface NodeDevice {
  id: string;
  name: string;
  /** `linux`, `darwin`, `win32`, or another platform name. Picks the icon. */
  platform?: string | null;
  status?: NodeDeviceStatus;
}

/**
 * Links between the device pages. The host owns routing: `href` builds a URL it can serve, and
 * `navigate` follows one without a page load. A plain click calls `navigate`, and a modified
 * click or a middle click follows the link natively.
 */
export interface NodeNavigation {
  href(deviceId: string | null, commandId?: number): string;
  navigate(href: string): void;
}
