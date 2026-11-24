import { useQuery } from "@tanstack/react-query";
import { devicesStatusSchema } from "@rome/api-types/devices";
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
