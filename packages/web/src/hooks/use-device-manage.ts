import type { NodeDeviceManage, NodeDeviceManageError } from "@rome-os/node-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchJson } from "@/lib/fetch-json";

const manageErrors = new Set<string>([
  "device_not_found",
  "invalid_device_name",
  "revocation_pending",
] satisfies NodeDeviceManageError[]);

/** Sends one device change to the backend. Resolves with the error code, or null on success. */
async function manageRequest(
  path: string,
  init: { method: "PATCH"; json: { name: string } } | { method: "DELETE" },
): Promise<NodeDeviceManageError | null> {
  try {
    await fetchJson<void>(path, { ...init, fallback: "unavailable" });
    return null;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return manageErrors.has(code) ? (code as NodeDeviceManageError) : "unavailable";
  }
}

/**
 * Rename and remove for the device pages. Each change reads the devices again,
 * including the chat folder picker's list. `onRemoved` runs after a device is removed.
 */
export function useDeviceManage(onRemoved?: (deviceId: string) => void): NodeDeviceManage {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const path = (deviceId: string) => `/api/devices/${encodeURIComponent(deviceId)}`;
    const refresh = () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["node-devices"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-locations"] }),
      ]);
    const after = async (error: NodeDeviceManageError | null) => {
      if (!error) await refresh();
      return error;
    };
    return {
      rename: async (deviceId, name) =>
        after(await manageRequest(path(deviceId), { method: "PATCH", json: { name } })),
      async remove(deviceId) {
        const error = await manageRequest(path(deviceId), { method: "DELETE" });
        // A pending revocation still revoked the device, so the list changed either way.
        if (error === "revocation_pending") void refresh();
        if (error) return error;
        void refresh();
        onRemoved?.(deviceId);
        return null;
      },
    };
  }, [onRemoved, queryClient]);
}
