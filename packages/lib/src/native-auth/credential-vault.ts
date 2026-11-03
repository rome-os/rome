import type { CloudCredential, InstanceSession } from "./types.js";
import { exactHttpsOrigin } from "./validation.js";

export interface SecureKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

interface VaultState {
  version: 1;
  cloud: CloudCredential | null;
  pendingCloudRevocation: CloudCredential | null;
  instances: Record<string, InstanceSession>;
}

const VAULT_KEY = "rome.native.credentials.v1";

function emptyState(): VaultState {
  return { version: 1, cloud: null, pendingCloudRevocation: null, instances: {} };
}

function parseState(raw: string | null): VaultState {
  if (!raw) return emptyState();
  try {
    const value = JSON.parse(raw) as Partial<VaultState>;
    if (value.version !== 1 || typeof value.instances !== "object" || value.instances === null) {
      return emptyState();
    }
    const instances: Record<string, InstanceSession> = {};
    for (const [origin, session] of Object.entries(value.instances)) {
      if (
        exactHttpsOrigin(origin) === origin &&
        session?.origin === origin &&
        session.cookieName === "rome_session" &&
        typeof session.token === "string" &&
        typeof session.expiresAt === "string"
      ) {
        instances[origin] = session;
      }
    }
    const cloud =
      typeof value.cloud?.accessToken === "string" &&
      typeof value.cloud.deviceSessionId === "string"
        ? value.cloud
        : null;
    const pendingCloudRevocation =
      typeof value.pendingCloudRevocation?.accessToken === "string" &&
      typeof value.pendingCloudRevocation.deviceSessionId === "string"
        ? value.pendingCloudRevocation
        : null;
    return { version: 1, cloud, pendingCloudRevocation, instances };
  } catch {
    return emptyState();
  }
}

export class CredentialVault {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly store: SecureKeyValueStore) {}

  private async read(): Promise<VaultState> {
    await this.queue;
    return parseState(await this.store.getItem(VAULT_KEY));
  }

  private update(mutator: (state: VaultState) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const state = parseState(await this.store.getItem(VAULT_KEY));
      mutator(state);
      await this.store.setItem(VAULT_KEY, JSON.stringify(state));
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async getCloudCredential(): Promise<CloudCredential | null> {
    return (await this.read()).cloud;
  }

  setCloudCredential(credential: CloudCredential): Promise<void> {
    return this.update((state) => {
      state.cloud = credential;
    });
  }

  clearCloudCredential(): Promise<void> {
    return this.update((state) => {
      state.cloud = null;
    });
  }

  quarantineCloudCredential(): Promise<void> {
    return this.update((state) => {
      state.pendingCloudRevocation = state.cloud;
      state.cloud = null;
    });
  }

  async getPendingCloudRevocation(): Promise<CloudCredential | null> {
    return (await this.read()).pendingCloudRevocation;
  }

  clearPendingCloudRevocation(): Promise<void> {
    return this.update((state) => {
      state.pendingCloudRevocation = null;
    });
  }

  async getInstanceSession(origin: string): Promise<InstanceSession | null> {
    const exactOrigin = exactHttpsOrigin(origin);
    if (!exactOrigin) return null;
    return (await this.read()).instances[exactOrigin] ?? null;
  }

  setInstanceSession(session: InstanceSession): Promise<void> {
    const origin = exactHttpsOrigin(session.origin);
    if (!origin || origin !== session.origin) throw new Error("Invalid instance session origin");
    return this.update((state) => {
      state.instances[origin] = session;
    });
  }

  clearInstanceSession(origin: string): Promise<void> {
    const exactOrigin = exactHttpsOrigin(origin);
    if (!exactOrigin) return Promise.resolve();
    return this.update((state) => {
      delete state.instances[exactOrigin];
    });
  }

  async getInstanceOrigins(): Promise<string[]> {
    return Object.keys((await this.read()).instances);
  }

  clearInstanceSessions(): Promise<void> {
    return this.update((state) => {
      state.instances = {};
    });
  }

  async clearAll(): Promise<void> {
    await this.queue;
    await this.store.deleteItem(VAULT_KEY);
  }
}
