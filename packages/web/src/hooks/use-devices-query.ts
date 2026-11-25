import { useQuery } from "@tanstack/react-query";
import { deviceListSchema, devicesStatusSchema } from "@rome/api-types/devices";
import { useTranslation } from "react-i18next";
import { fetchJson } from "@/lib/fetch-json";

/** The linked devices and the service's connection, read every 15 seconds
 *  while `enabled`, which it is by default. */
export function useDevicesQuery({ enabled = true }: { enabled?: boolean } = {}) {
  const { t } = useTranslation("settings");
  return useQuery({
    enabled,
    queryKey: ["node-devices"],
    refetchInterval: 15_000,
    retry: false,
    queryFn: async ({ signal }) =>
      devicesStatusSchema.parse(
        await fetchJson<unknown>("/api/devices", { signal, fallback: t("devices.loadFailed") }),
      ),
  });
}

/** The account's devices from Rome Cloud's list, without revoked ones and
 *  without asking any device whether it is online, read every 15 seconds
 *  while `enabled`. The list `system:add_device` sends its card with. */
export function useDeviceListQuery({ enabled = true }: { enabled?: boolean } = {}) {
  const { t } = useTranslation("settings");
  return useQuery({
    enabled,
    queryKey: ["node-devices", "list"],
    refetchInterval: 15_000,
    retry: false,
    queryFn: async ({ signal }) =>
      deviceListSchema.parse(
        await fetchJson<unknown>("/api/devices/list", {
          signal,
          fallback: t("devices.loadFailed"),
        }),
      ),
  });
}
