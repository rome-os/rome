import { isRecord } from "./actions.js";
import type { ConnectionStatus } from "./client.js";
import type { DeviceConnector } from "./connector.js";

export interface DeviceStatus {
  id: string;
  name: string;
  platform: string | null;
  status: "connected" | "not_connected" | "unknown" | "revoked";
  /** The device's audit log, from system.info. Absent for hosts that predate it. */
  audit?: { state: "ok" | "unavailable"; code?: string; message?: string };
}

export interface DevicesStatus {
  connection: ConnectionStatus;
  checkedAt: string;
  devices: DeviceStatus[];
}

/** A snapshot at least this old starts a new check when it is read. */
const REFRESH_AFTER_MS = 10_000;

/** Shares read-only probes across clients. A timeout does not establish that a device is offline. */
export class DeviceStatusReader {
  private cached?: DevicesStatus;
  private pending?: Promise<DevicesStatus>;
  private generation = 0;

  constructor(private connector: Pick<DeviceConnector, "list" | "run" | "getStatus">) {}

  /** Drops the snapshot, so the next read waits for a check that starts after this call. */
  invalidate() {
    this.generation++;
    this.cached = undefined;
    this.pending = undefined;
  }

  /**
   * The last snapshot, at once. A stale one starts a check in the background, and a later read
   * gets its result. Only a read without a snapshot waits: the first one, or one after
   * invalidate. A failed background check keeps the last snapshot.
   */
  async read(): Promise<DevicesStatus> {
    if (!this.cached) return this.refresh();
    if (Date.now() - Date.parse(this.cached.checkedAt) >= REFRESH_AFTER_MS)
      this.refresh().catch(() => undefined);
    return this.cached;
  }

  /** Runs one check at a time. Callers that arrive during a check share it. */
  private refresh(): Promise<DevicesStatus> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = this.check()
      .then((snapshot) => {
        if (generation === this.generation) this.cached = snapshot;
        return snapshot;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  private async check(): Promise<DevicesStatus> {
    const list = await this.connector.list();
    if (!isRecord(list) || !Array.isArray(list.items)) throw new Error("Invalid device list");
    const devices: DeviceStatus[] = list.items.map((item) => {
      if (!isRecord(item) || typeof item.id !== "string") throw new Error("Invalid device record");
      return {
        id: item.id,
        name: typeof item.device_name === "string" ? item.device_name : item.id,
        platform: typeof item.platform === "string" ? item.platform : null,
        status: item.revoked_at ? "revoked" : "unknown",
      };
    });
    // Bound both parallel requests and each refresh's work, including large account histories.
    const deadline = Date.now() + 15_000;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, devices.length) }, async () => {
        while (next < devices.length && Date.now() < deadline) {
          const device = devices[next++];
          if (device.status === "revoked") continue;
          const response = await this.connector.run(device.id, "system.info", {}, 3000);
          device.status = response.ok
            ? "connected"
            : response.error.code === "target_unavailable"
              ? "not_connected"
              : "unknown";
          const audit =
            response.ok && isRecord(response.result) ? response.result.audit : undefined;
          if (isRecord(audit) && (audit.state === "ok" || audit.state === "unavailable"))
            device.audit = {
              state: audit.state,
              ...(typeof audit.code === "string" ? { code: audit.code } : {}),
              ...(typeof audit.message === "string" ? { message: audit.message } : {}),
            };
        }
      }),
    );
    const connection = this.connector.getStatus();
    if (connection !== "online") {
      for (const device of devices) if (device.status !== "revoked") device.status = "unknown";
    }
    return { connection, checkedAt: new Date().toISOString(), devices };
  }
}
