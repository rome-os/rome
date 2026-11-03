import type { PowerSaveBlocker } from "electron";
import type { DeviceStatus } from "./cloud/device-host";

/**
 * Long enough to ride out a network outage. Releasing sooner would let the
 * computer sleep, and a sleeping computer never reconnects on its own.
 */
export const DISCONNECTED_GRACE_MS = 30 * 60_000;

/**
 * Keeps the display on while Rome may use this computer, which also keeps the
 * system out of idle sleep. Closing the lid or choosing Sleep still sleeps it.
 */
export class KeepAwake {
  private id: number | null = null;
  private grace: ReturnType<typeof setTimeout> | undefined;
  /** The grace ran out, so only a new connection takes the hold again. */
  private expired = false;

  constructor(
    private readonly blocker: Pick<PowerSaveBlocker, "start" | "stop">,
    private readonly graceMs = DISCONNECTED_GRACE_MS,
  ) {}

  /**
   * Holds while the device is connected. A device that is connecting or
   * offline keeps the hold for up to the grace period, counted from when it
   * stopped being connected. An off or disabled device releases at once.
   */
  sync(status: DeviceStatus): void {
    if (status.state === "connected") {
      this.clearGrace();
      this.expired = false;
      this.hold();
    } else if (status.state === "connecting" || status.state === "offline") {
      if (this.expired) return;
      this.hold();
      this.grace ??= setTimeout(() => {
        this.grace = undefined;
        this.expired = true;
        this.drop();
      }, this.graceMs);
    } else {
      this.release();
    }
  }

  /** Releases at once, and the next status starts over. */
  release(): void {
    this.clearGrace();
    this.expired = false;
    this.drop();
  }

  private hold(): void {
    this.id ??= this.blocker.start("prevent-display-sleep");
  }

  private drop(): void {
    if (this.id === null) return;
    this.blocker.stop(this.id);
    this.id = null;
  }

  private clearGrace(): void {
    clearTimeout(this.grace);
    this.grace = undefined;
  }
}
