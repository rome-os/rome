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

/** This computer as a device, as the app that connects it reports it. */
export type NodeThisDeviceState = "connected" | "connecting" | "offline" | "disabled";

/** The computer the host page runs on, with the switch that lets the account's Rome use it. */
export interface NodeThisDevice {
  id: string;
  /** Shown until the account's devices list `id`. */
  name: string;
  /** `macos`, `linux`, `windows`, or another platform name. Picks the icon. */
  platform?: string | null;
  state: NodeThisDeviceState;
  /** True while a change the user asked for is applied. */
  busy?: boolean;
  /** The Rome Cloud page that removes this computer from the account. Its menu links there. */
  removeUrl?: string;
  onEnabledChange(enabled: boolean): void;
}

/** Why the host could not rename or remove a device. */
export type NodeDeviceManageError =
  | "device_not_found"
  | "invalid_device_name"
  | "revocation_pending"
  | "unavailable";

/**
 * Account-level changes to a device. The host sends them to Rome Cloud, resolves with null on
 * success, and then passes the changed devices back in.
 */
export interface NodeDeviceManage {
  rename(deviceId: string, name: string): Promise<NodeDeviceManageError | null>;
  /**
   * Revokes the device and deletes it from the account. `revocation_pending` means it is revoked
   * but stays listed as revoked until Rome Cloud confirms; removing it again then deletes it.
   */
  remove(deviceId: string): Promise<NodeDeviceManageError | null>;
}
