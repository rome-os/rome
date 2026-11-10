import type { CloudCredential } from "@rome-os/libs/native-auth";
import {
  connectHost,
  connectLimitedHost,
  type HostEvent,
  type HostOptions,
  type LimitedHostOptions,
} from "@rome-os/node-core/host";
import { createLogger } from "../logger";

const log = createLogger("device-host");

/** The Gateway connection of this computer, whatever Rome may do through it. */
type DeviceConnection = "connecting" | "connected" | "offline";

/**
 * This computer as a device of the signed-in account. `off`: signed out, or a launch that does
 * not connect. Signed in, the app is always connected (`connection`), and two choices apply on
 * top of it: `computerUse` (may Rome run programs here) and `notifications` (does the app show
 * Rome Cloud's notifications). `deviceId` is this computer's id in the device list.
 *
 * `state` is what pages that predate `connection` read: while Computer use is off it is
 * `disabled`, whatever the connection is, as it was when that switch disconnected the app.
 */
export type DeviceStatus =
  | { state: "off" }
  | {
      state: "disabled" | DeviceConnection;
      deviceId: string;
      name: string;
      connection: DeviceConnection;
      computerUse: boolean;
      notifications: boolean;
    };

export interface DeviceHostOptions {
  cloudOrigin: string;
  /** The name to use until Rome Cloud reports the one the account sees. */
  deviceName: string;
  credential(): Promise<CloudCredential | null>;
  /** The user's Computer use choice: whether Rome may run programs on this computer. */
  enabled(): boolean;
  /** The user's choice to show notifications from Rome Cloud. On when omitted. */
  notificationsEnabled?(): boolean;
  /** Rome Cloud no longer accepts the credential, so the app signs out. */
  onRevoked(): Promise<void>;
  /** Runs once, before the first connection. */
  prepare?(): Promise<void>;
  onStatus?(status: DeviceStatus): void;
  /** Rome Cloud sent a notification over the Gateway connection for this app to show. */
  onNotification?: HostOptions["onNotification"];
  /** Every remote request is recorded here before it runs. */
  audit: HostOptions["audit"];
  connect?: (options: HostOptions) => Promise<void>;
  /** The connection used while Computer use is off. It answers and runs nothing. */
  connectLimited?: (options: LimitedHostOptions) => Promise<void>;
}

/** What a status holds besides the notifications flag, which is read when the status is given. */
type Current =
  | { state: "off" }
  | {
      state: DeviceConnection | "disabled";
      deviceId: string;
      name: string;
      connection: DeviceConnection;
      computerUse: boolean;
    };

class SignInRequired extends Error {
  constructor() {
    super("Sign in to Rome Cloud to connect this computer.");
  }
}

/**
 * Connects this computer to the account's device Gateway with the desktop
 * app's own Rome Cloud sign-in, for as long as the app runs signed in.
 * The sign-in and the device are one record in Rome Cloud: revoking the device
 * signs the app out, and signing out disconnects the device.
 *
 * With Computer use on, the user's Rome can run programs here. With it off,
 * the connection stays but is limited: it answers system.info, refuses
 * everything else, and runs nothing. Notifications arrive either way.
 */
export class DeviceHost {
  private running: {
    abort: AbortController;
    done: Promise<void>;
    decided: Promise<void>;
  } | null = null;
  private current: Current = { state: "off" };
  private prepared: Promise<void> | null = null;

  constructor(private readonly options: DeviceHostOptions) {}

  status(): DeviceStatus {
    return this.current.state === "off"
      ? { state: "off" }
      : { ...this.current, notifications: this.options.notificationsEnabled?.() ?? true };
  }

  /** Reports the status again, after the notifications choice changed. Nothing reconnects. */
  refresh(): void {
    this.options.onStatus?.(this.status());
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
    const computerUse = this.options.enabled();
    // Only Computer use runs programs, which is what the login shell's PATH is for.
    if (computerUse) {
      this.prepared ??= (this.options.prepare?.() ?? Promise.resolve()).catch((err) => {
        log.warn(`Preparing this computer for Rome failed (${String(err)})`);
      });
      await this.prepared;
      if (signal.aborted) return;
    }

    const { cloudOrigin } = this.options;
    let name = this.options.deviceName;
    // Sticky: after "revoked" the host stops the connection, which reports "stopped".
    let revoked = false;
    const report = (connection: DeviceConnection) =>
      this.setStatus({
        state: computerUse ? connection : "disabled",
        deviceId,
        name,
        connection,
        computerUse,
      });
    report("connecting");
    decide();
    const shared = {
      cloudUrl: cloudOrigin,
      name,
      signal,
      audit: this.options.audit,
      onNotification: this.options.onNotification,
      credentials: {
        load: async () => ({
          cloudUrl: cloudOrigin,
          token: credential.accessToken,
          deviceId: credential.deviceSessionId,
          name,
        }),
        // Only the name changes here; the token belongs to the app's sign-in.
        save: async (session: { name: string }) => {
          name = session.name;
        },
        // Rome Cloud rejected the token. onRevoked signs the app out.
        clear: async () => undefined,
      },
      authorize: async () => {
        throw new SignInRequired();
      },
      onEvent: (event: HostEvent) => {
        // Stopping on purpose reports "stopped"; stop() sets the status itself.
        if (signal.aborted) return;
        if (event.type === "device") name = event.name;
        if (event.type !== "connection") return;
        if (event.status === "revoked") revoked = true;
        if (event.status === "online") report("connected");
        else if (event.status === "connecting") report("connecting");
        else report("offline");
      },
    };
    try {
      if (computerUse) await (this.options.connect ?? connectHost)(shared);
      else await (this.options.connectLimited ?? connectLimitedHost)(shared);
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
      report("offline");
      return;
    }
    this.setStatus({ state: "off" });
  }

  private setStatus(status: Current): void {
    if (JSON.stringify(status) === JSON.stringify(this.current)) return;
    this.current = status;
    this.options.onStatus?.(this.status());
  }
}
