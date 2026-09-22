import { join } from "node:path";
import {
  CredentialSynchronizationError,
  getAgentDir,
  ModelRuntime,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import {
  PiCredentialBoundary,
  type PiCredentialRuntime,
  type PiStoredCredentialSafety,
} from "./credential-boundary.js";

export interface CreatePiCredentialBoundaryOptions {
  agentDir?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  refreshTimeoutMs?: number;
}

function hasCredentialReference(value: string): boolean {
  if (value.startsWith("!")) return true;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "$") continue;
    const next = value[index + 1];
    if (next === "$" || next === "!") {
      index += 1;
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", index + 2);
      if (end !== -1 && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.slice(index + 2, end))) {
        return true;
      }
      continue;
    }
    if (next !== undefined && /[A-Za-z_]/u.test(next)) return true;
  }
  return false;
}

export function inspectPiStoredCredential(
  providerId: string,
  authPath: string,
): PiStoredCredentialSafety {
  const credential = readStoredCredential(providerId, authPath);
  if (!credential) return "missing";
  if (credential.type === "oauth") return "oauth";
  if (credential.key === undefined) return "literal";
  return hasCredentialReference(credential.key) ? "expression" : "literal";
}

/** Create the isolated SDK boundary without loading models.json or refreshing on startup. */
export async function createPiCredentialBoundary(
  options: CreatePiCredentialBoundaryOptions = {},
): Promise<PiCredentialBoundary> {
  const agentDir = options.agentDir ?? getAgentDir();
  const authPath = join(agentDir, "auth.json");
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const adapter: PiCredentialRuntime = {
    getProviders: () => runtime.getProviders(),
    getProvider: (providerId) => runtime.getProvider(providerId),
    getModels: (providerId) => runtime.getModels(providerId),
    listCredentials: () => runtime.listCredentials(),
    getProviderAuthStatus: (providerId) => runtime.getProviderAuthStatus(providerId),
    getAvailable: (providerId) => runtime.getAvailable(providerId),
    login: (providerId, type, interaction) =>
      runtime.login(providerId, type, {
        prompt: (prompt) => interaction.prompt({ type: prompt.type }),
        notify: (event) => interaction.notify(event),
      }),
    logout: (providerId) => runtime.logout(providerId),
    refresh: (refreshOptions) => runtime.refresh(refreshOptions),
    getError: () => runtime.getError(),
  };
  return new PiCredentialBoundary({
    runtime: adapter,
    inspectStoredCredential: (providerId) => inspectPiStoredCredential(providerId, authPath),
    isCredentialSynchronizationError: (error) => error instanceof CredentialSynchronizationError,
    environment: options.environment,
    refreshTimeoutMs: options.refreshTimeoutMs,
  });
}
