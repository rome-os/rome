import type { AppKeyDto, AppKeysListResponse } from "@rome/api-types/app-keys";
import { fetchJson } from "@/lib/fetch-json";

export type { AppKeyDto };

/** Shared react-query key: the Connections-list row and the app-keys page read
 * the same cache, so a save or remove on the page updates the row's count. */
export const APP_KEYS_QUERY_KEY = ["app-keys"] as const;

export async function fetchAppKeys(): Promise<AppKeyDto[]> {
  const payload = await fetchJson<AppKeysListResponse>("/api/app-keys", {
    fallback: "Failed to load app keys.",
  });
  return payload.keys;
}

export async function saveAppKey(input: {
  name: string;
  label: string;
  value: string;
}): Promise<{ overridden: boolean }> {
  return await fetchJson<{ ok: boolean; overridden: boolean }>(
    `/api/app-keys/${encodeURIComponent(input.name)}`,
    {
      method: "PUT",
      json: { label: input.label, value: input.value },
      fallback: "Failed to save app key.",
    },
  );
}

export async function deleteAppKey(name: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/app-keys/${encodeURIComponent(name)}`, {
    method: "DELETE",
    fallback: "Failed to remove app key.",
  });
}
