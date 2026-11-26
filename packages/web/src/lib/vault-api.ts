import type { VaultListResponse, VaultPinState, VaultSecretDto } from "@rome/api-types/vault";
import i18n from "i18next";
import { apiErrorMessageFrom } from "@/lib/api-error";

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
/** Under the list's key, so refreshing the list refreshes the PIN state too. */
export const VAULT_PIN_QUERY_KEY = [...VAULT_QUERY_KEY, "pin"] as const;

const PIN_ERROR_CODES = ["invalid_pin", "wrong_pin", "locked", "pin_not_set", "pin_already_set"];

/**
 * A failed vault call. `message` is what the guardian reads: the PIN answers
 * and an outdated signer are written in the current language, any other
 * failure carries the server's text. `code` tells the two apart.
 */
export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }

  /** The signer rejected the PIN or refused to check it. */
  get isPinError(): boolean {
    return this.code !== null && PIN_ERROR_CODES.includes(this.code);
  }
}

const clock = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";

/** The line for a locked PIN, shown on the card and in Settings. */
export function vaultLockedText(lockedUntil: string | undefined): string {
  return i18n.t("vaultPin.locked", { ns: "common", time: clock(lockedUntil) });
}

function failure(body: Record<string, unknown> | null, fallback: string): VaultError {
  const named = typeof body?.code === "string" ? body.code : body?.error;
  const code = typeof named === "string" ? named : null;
  const text = (key: string, options?: Record<string, unknown>) =>
    i18n.t(`vaultPin.${key}`, { ns: "common", ...options });
  const message =
    code === "wrong_pin"
      ? text("wrong", { count: Number(body?.attemptsLeft) || 0 })
      : code === "locked"
        ? vaultLockedText(typeof body?.lockedUntil === "string" ? body.lockedUntil : undefined)
        : code === "pin_not_set"
          ? text("notSet")
          : code === "signer_outdated"
            ? text("signerOutdated")
            : apiErrorMessageFrom(PIN_ERROR_CODES.includes(code ?? "") ? null : body, fallback);
  return new VaultError(message, code);
}

// A PIN answer carries a code and a counter the caller needs.
async function vaultFetch<T>(
  url: string,
  options: { method?: string; json?: unknown; fallback: string },
): Promise<T> {
  const response = await fetch(url, {
    method: options.method,
    credentials: "include",
    cache: "no-store",
    ...(options.json === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.json),
        }),
  });
  if (!response.ok) throw failure(await response.json().catch(() => null), options.fallback);
  return (await response.json()) as T;
}

const fetchVault = () =>
  vaultFetch<VaultListResponse>("/api/vault", { fallback: "Failed to load the vault." });

export async function fetchVaultSecrets(): Promise<VaultItem[]> {
  const payload = await fetchVault();
  return payload.secrets.map((secret) => ({
    name: secret.name,
    label: secret.description || secret.name,
    description: secret.description,
    overridden: false,
    lastUsedAt: secret.lastUsedAt,
    grantedUntil: secret.grantedUntil,
  }));
}

export async function fetchVaultPin(): Promise<VaultPinState> {
  return (await fetchVault()).pin;
}

export async function saveVaultSecret(input: {
  name: string;
  label: string;
  value: string;
  pin?: string;
}): Promise<{ overridden: false }> {
  await vaultFetch<{ ok: boolean }>(`/api/vault/${encodeURIComponent(input.name)}`, {
    method: "PUT",
    json: { value: input.value, description: input.label, pin: input.pin },
    fallback: "Failed to save the secret.",
  });
  return { overridden: false };
}

export async function deleteVaultSecret(name: string): Promise<void> {
  await vaultFetch<{ ok: boolean }>(`/api/vault/${encodeURIComponent(name)}`, {
    method: "DELETE",
    fallback: "Failed to remove the secret.",
  });
}

export async function setVaultPin(pin: string): Promise<void> {
  await vaultFetch<{ ok: boolean }>("/api/vault/pin", {
    method: "POST",
    json: { pin },
    fallback: "Failed to set the PIN.",
  });
}

/** Deletes every secret and sets a new PIN. Needs no old PIN. */
export async function resetVault(pin: string): Promise<void> {
  await vaultFetch<{ ok: boolean }>("/api/vault/reset", {
    method: "POST",
    json: { pin },
    fallback: "Failed to reset the vault.",
  });
}

/** Grants the secrets, all or none, and approves the request that asked for them. */
export async function grantVaultSecret(input: {
  approvalId: string;
  names: string[];
  ttlMinutes: number;
  pin: string;
}): Promise<void> {
  await vaultFetch<{ ok: boolean }>("/api/vault/grants", {
    method: "POST",
    json: input,
    fallback: "Failed to allow the secrets.",
  });
}
