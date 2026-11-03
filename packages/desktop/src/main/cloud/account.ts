import {
  CloudApi,
  type CloudCredential,
  type CloudInstance,
  CredentialVault,
  type InstanceSession,
  InstanceSessionCoordinator,
  NativeAuthError,
  type SecureKeyValueStore,
} from "@rome-os/libs/native-auth";
import { createLogger } from "../logger";
import { type ComputerPlatform, signInToRomeCloud } from "./sign-in";

const log = createLogger("cloud-account");

/** Where the instance session goes so the main window sends it. */
export interface InstanceCookieStore {
  install(session: InstanceSession): Promise<void>;
  clear(origin: string): Promise<void>;
}

export interface CloudAccountOptions {
  cloudOrigin: string;
  store: SecureKeyValueStore;
  cookies: InstanceCookieStore;
  fetchImpl: typeof fetch;
  openBrowser(url: string): Promise<void>;
  device: {
    name: string;
    platform: ComputerPlatform;
    appVersion: string;
    osVersion: string;
  };
}

/**
 * This computer's Rome Cloud sign-in as the desktop app, and the sessions it
 * opens on the user's hosted instances. The protocol lives in
 * `@rome-os/libs/native-auth`, shared with Rome Mobile; this class only wires
 * it to Electron's keychain, cookies, and browser.
 */
export class CloudAccount {
  readonly cloudOrigin: string;
  private readonly api: CloudApi;
  private readonly vault: CredentialVault;
  private readonly sessions: InstanceSessionCoordinator;
  private signInAbort: AbortController | null = null;

  constructor(private readonly options: CloudAccountOptions) {
    this.api = new CloudApi(options.cloudOrigin, options.fetchImpl);
    this.cloudOrigin = this.api.origin;
    this.vault = new CredentialVault(options.store);
    this.sessions = new InstanceSessionCoordinator(
      this.api,
      this.vault,
      options.cookies,
      options.fetchImpl,
    );
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.vault.getCloudCredential()) !== null;
  }

  /** The sign-in this computer also connects to the device Gateway with. */
  credential(): Promise<CloudCredential | null> {
    return this.vault.getCloudCredential();
  }

  /** One sign-in at a time: starting another cancels the browser wait. */
  async signIn(): Promise<void> {
    this.signInAbort?.abort();
    const abort = new AbortController();
    this.signInAbort = abort;
    try {
      const credential = await signInToRomeCloud({
        cloudOrigin: this.cloudOrigin,
        openBrowser: this.options.openBrowser,
        deviceName: this.options.device.name,
        platform: this.options.device.platform,
        appVersion: this.options.device.appVersion,
        osVersion: this.options.device.osVersion,
        fetchImpl: this.options.fetchImpl,
        signal: abort.signal,
      });
      // A cancelled sign-in, or one a newer sign-in replaced, never becomes
      // the account's credential, even if Rome Cloud answered it.
      if (abort.signal.aborted || this.signInAbort !== abort) {
        throw new NativeAuthError("cancelled", "Sign-in was cancelled");
      }
      await this.vault.setCloudCredential(credential);
    } finally {
      if (this.signInAbort === abort) this.signInAbort = null;
    }
  }

  cancelSignIn(): void {
    this.signInAbort?.abort();
  }

  /**
   * Revokes the credential at Rome Cloud when it can, then forgets it and
   * every instance session locally either way: signing out must work offline.
   */
  async signOut(): Promise<void> {
    const credential = await this.vault.getCloudCredential();
    if (credential) {
      try {
        await this.api.revoke(credential);
      } catch (err) {
        log.warn(`Rome Cloud revoke failed; signing out locally (${String(err)})`);
      }
    }
    for (const origin of await this.vault.getInstanceOrigins()) {
      await this.options.cookies.clear(origin);
    }
    await this.vault.clearAll();
  }

  async listInstances(): Promise<CloudInstance[]> {
    const credential = await this.vault.getCloudCredential();
    if (!credential) throw new NativeAuthError("cloud_unauthorized", "Sign in to Rome Cloud first");
    try {
      return await this.api.listInstances(credential);
    } catch (err) {
      await this.forgetRejectedCredential(err);
      throw err;
    }
  }

  /** Installs a fresh `rome_session` for the instance in the window's cookies. */
  async openSession(instance: CloudInstance): Promise<void> {
    try {
      await this.sessions.restore(instance);
    } catch (err) {
      await this.forgetRejectedCredential(err);
      throw err;
    }
  }

  // Rome Cloud said the credential is dead (revoked from the account page, or
  // the session expired). Keeping it would fail the same way on every launch.
  private async forgetRejectedCredential(err: unknown): Promise<void> {
    if (err instanceof NativeAuthError && err.code === "cloud_unauthorized") {
      await this.vault.clearCloudCredential();
    }
  }
}
