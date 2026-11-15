// A device's lifecycle, as it reaches its connections: a device removed from
// the account loses its rows, and a full device list prunes the rows of
// devices no longer on it. Personal data hears only of the origins a removal
// leaves with no install, through `turnOriginOff`. Concept:
// docs/domains/connections.md#device-connection.

import type { DeviceList } from "@rome/api-types/devices";
import type { DeviceManageResult } from "../../desktops/node-devices.js";
import { createLogger } from "../../logger.js";
import type { DeviceConnectionsRepository } from "./repository.js";

const log = createLogger("device-lifecycle");

interface DeviceService {
  /** `partial` when Cloud's answer says it is one page of more. */
  listDevices(): Promise<(DeviceList & { partial?: true }) | null>;
  removeDevice(deviceId: string): Promise<DeviceManageResult>;
}

export interface DeviceLifecycleDeps {
  connections: () => Pick<DeviceConnectionsRepository, "removeDevice" | "keepOnly">;
  /** Turns off a personal-data origin whose install is gone. Its data stays. */
  turnOriginOff: (originId: string) => void;
}

/** The node devices service, with each removal and full list applied to the device rows. */
export function withDeviceLifecycle<S extends DeviceService>(
  service: S,
  deps: DeviceLifecycleDeps,
): S {
  return {
    ...service,
    async listDevices() {
      const answer = await service.listDevices();
      if (!answer) return answer;
      const { partial, ...list } = answer;
      // Only a whole list prunes: null is a failure, an empty list is more
      // likely a fault than an account with no devices, and a page is not
      // the whole account.
      if (partial) {
        log.warn("device list is one page of more; connections not pruned", {
          listed: list.devices.length,
        });
      } else if (list.devices.length > 0) {
        const pruned = deps.connections().keepOnly(list.devices.map((device) => device.id));
        if (pruned > 0) log.info("pruned connections of devices no longer listed", { pruned });
      }
      return list as typeof answer;
    },
    async removeDevice(deviceId: string) {
      const result = await service.removeDevice(deviceId);
      if (result.ok) {
        const { orphanedOrigins } = deps.connections().removeDevice(deviceId);
        for (const origin of orphanedOrigins) deps.turnOriginOff(origin);
      }
      return result;
    },
  };
}
