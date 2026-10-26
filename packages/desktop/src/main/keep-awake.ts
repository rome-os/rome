import type { PowerSaveBlocker } from "electron";
import type { DeviceStatus } from "./cloud/device-host";

/**
 * Keeps the display on while Rome may use this computer, which also keeps the
 * system out of idle sleep. Closing the lid or choosing Sleep still sleeps it.
 */
export class KeepAwake {
  private id: number | null = null;

  constructor(private readonly blocker: Pick<PowerSaveBlocker, "start" | "stop">) {}

  /** Holds while the device is on, whether or not it is connected right now. */
  sync(status: DeviceStatus): void {
    if (status.state === "off" || status.state === "disabled") this.release();
    else this.id ??= this.blocker.start("prevent-display-sleep");
  }

  release(): void {
    if (this.id === null) return;
    this.blocker.stop(this.id);
    this.id = null;
  }
}
