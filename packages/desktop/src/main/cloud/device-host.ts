import type { CloudCredential } from "@rome-os/libs/native-auth";
import { connectHost, type HostOptions } from "@rome-os/node-core/host";
import { createLogger } from "../logger";

const log = createLogger("device-host");

/**
 * Whether this computer is reachable as a device of the signed-in account.
 * `off`: signed out, or a launch that does not connect. `disabled`: the user
 * turned the device off. `deviceId` is this computer's id in the device list.
 */
export type DeviceStatus =
  | { state: "off" }
  | { state: "disabled" | "connecting" | "connected" | "offline"; deviceId: string; name: string };

export interface DeviceHostOptions {
  cloudOrigin: string;
  /** The name to use until Rome Cloud reports the one the account sees. */
  deviceName: string;
  credential(): Promise<CloudCredential | null>;
  /** The user's choice to let Rome use this computer. */
  enabled(): boolean;
  /** Rome Cloud no longer accepts the credential, so the app signs out. */
  onRevoked(): Promise<void>;
  /** Runs once, before the first connection. */
  prepare?(): Promise<void>;
  onStatus?(status: DeviceStatus): void;
  connect?: (options: HostOptions) => Promise<void>;
}

class SignInRequired extends Error {
  constructor() {
    super("Sign in to Rome Cloud to connect this computer.");
  }
}

/**
 * Connects this computer to the account's device Gateway with the desktop
 * app's own Rome Cloud sign-in, so the user's Rome can run programs here.
 * The sign-in and the device are one record in Rome Cloud: revoking the device
 * signs the app out, and signing out disconnects the device.
 */
export class DeviceHost {
  private running: {
    abort: AbortController;
    done: Promise<void>;
    decided: Promise<void>;
  } | null = null;
  private current: DeviceStatus = { state: "off" };
  private prepared: Promise<void> | null = null;

  constructor(private readonly options: DeviceHostOptions) {}

  status(): DeviceStatus {
    return this.current;
  }

  /**
   * Does nothing while a connection runs or the app is signed out. Resolves
   * once the status says whether this run connects, so a caller that changed
   * the switch can answer with the new status.
   */
  start(): Promise<void> {
    if (this.running) return this.running.decided;
    const abort = new AbortController();
    let decide: () => void = () => undefined;
    const decided = new Promise<void>((resolve) => {
      decide = resolve;
    });
    const done = this.run(abort.signal, decide).finally(() => {
      decide();
      if (this.running?.abort === abort) this.running = null;
    });
    this.running = { abort, done, decided };
    return decided;
  }

  async stop(): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.abort.abort();
    await running.done;
    this.setStatus({ state: "off" });
  }

  private async run(signal: AbortSignal, decide: () => void): Promise<void> {
    const credential = await this.options.credential();
    if (!credential || signal.aborted) {
      this.setStatus({ state: "off" });
      return;
    }
    const deviceId = credential.deviceSessionId;
    if (!this.options.enabled()) {
      this.setStatus({ state: "disabled", deviceId, name: this.options.deviceName });
      return;
    }
    this.prepared ??= (this.options.prepare?.() ?? Promise.resolve()).catch((err) => {
      log.warn(`Preparing this computer for Rome failed (${String(err)})`);
    });
    await this.prepared;
    if (signal.aborted) return;

    const { cloudOrigin } = this.options;
    let name = this.options.deviceName;
    // Sticky: after "revoked" the host stops the connection, which reports "stopped".
    let revoked = false;
    this.setStatus({ state: "connecting", deviceId, name });
    decide();
    try {
      await (this.options.connect ?? connectHost)({
        cloudUrl: cloudOrigin,
        name,
        signal,
        credentials: {
          load: async () => ({
            cloudUrl: cloudOrigin,
            token: credential.accessToken,
            deviceId: credential.deviceSessionId,
            name,
          }),
          // Only the name changes here; the token belongs to the app's sign-in.
          save: async (session) => {
            name = session.name;
          },
          // Rome Cloud rejected the token. onRevoked signs the app out.
          clear: async () => undefined,
        },
        authorize: async () => {
          throw new SignInRequired();
        },
        onEvent: (event) => {
          // Stopping on purpose reports "stopped"; stop() sets the status itself.
          if (signal.aborted) return;
          if (event.type === "device") name = event.name;
          if (event.type !== "connection") return;
          if (event.status === "revoked") revoked = true;
          if (event.status === "online") this.setStatus({ state: "connected", deviceId, name });
          else if (event.status === "connecting")
            this.setStatus({ state: "connecting", deviceId, name });
          else this.setStatus({ state: "offline", deviceId, name });
        },
      });
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof SignInRequired || revoked) {
        log.info("Rome Cloud revoked this computer; signing out");
        this.setStatus({ state: "off" });
        // Not awaited: signing out stops this host, which waits for this run.
        void this.options.onRevoked().catch((revokeErr) => {
          log.error(`Signing out after revocation failed (${String(revokeErr)})`);
        });
        return;
      }
      log.warn(`This computer disconnected from Rome (${String(err)})`);
      this.setStatus({ state: "offline", deviceId, name });
      return;
    }
    this.setStatus({ state: "off" });
  }

  private setStatus(status: DeviceStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.current)) return;
    this.current = status;
    this.options.onStatus?.(status);
  }
}
