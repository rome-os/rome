import type { VaultListResponse, VaultSecretDto } from "@rome/api-types/vault";
import { fetchJson } from "@/lib/fetch-json";

/** One vault secret as the shared keys row reads it: `label` is the title, the description or else the name. */
export interface VaultItem {
  name: string;
  label: string;
  description: string;
  overridden: false;
  lastUsedAt: VaultSecretDto["lastUsedAt"];
  grantedUntil?: string;
}

export const VAULT_QUERY_KEY = ["vault"] as const;

export async function fetchVaultSecrets(): Promise<VaultItem[]> {
  const payload = await fetchJson<VaultListResponse>("/api/vault", {
    fallback: "Failed to load the vault.",
  });
  return payload.secrets.map((secret) => ({
    name: secret.name,
    label: secret.description || secret.name,
    description: secret.description,
    overridden: false,
    lastUsedAt: secret.lastUsedAt,
    grantedUntil: secret.grantedUntil,
  }));
}

export async function saveVaultSecret(input: {
  name: string;
  label: string;
  value: string;
}): Promise<{ overridden: false }> {
  await fetchJson<{ ok: boolean }>(`/api/vault/${encodeURIComponent(input.name)}`, {
    method: "PUT",
    json: { value: input.value, description: input.label },
    fallback: "Failed to save the secret.",
  });
  return { overridden: false };
}

export async function deleteVaultSecret(name: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/vault/${encodeURIComponent(name)}`, {
    method: "DELETE",
    fallback: "Failed to remove the secret.",
  });
}
