import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { fetchJson } from "@/lib/fetch-json";
import { PageBody, PageHeader, PageShell } from "@/shell/PageShell";

/** A device connection as `GET /api/device-connections` lists it, in the fields this page reads. */
interface DeviceConnection {
  capability: string;
  title: string;
  device: { name: string | null };
  state: "working" | "off" | "broken";
}

/**
 * Where a connect card's Connect leads for a device capability
 * (`/connections/device/:capability`). The device's own app opens its flow at
 * this path; in a browser the page says to connect on the device.
 */
export default function DeviceConnectPage() {
  const { t } = useTranslation("settings");
  const { capability = "" } = useParams();
  const query = useQuery({
    queryKey: ["device-connections"],
    refetchInterval: 15_000,
    retry: false,
    queryFn: ({ signal }) =>
      fetchJson<{ connections: DeviceConnection[] }>("/api/device-connections", {
        signal,
        fallback: t("connections.errorTitle"),
      }),
  });
  const ofKind = (query.data?.connections ?? []).filter((c) => c.capability === capability);
  const working = ofKind.find((c) => c.state === "working");
  const title = ofKind[0]?.title ?? capability;
  const device = working?.device.name ?? ofKind[0]?.device.name ?? t("deviceConnect.yourDevice");
  return (
    <PageShell>
      <PageBody>
        <PageHeader
          title={t("deviceConnect.title", { title })}
          description={
            working
              ? t("deviceConnect.connected", { title, device })
              : t("deviceConnect.onDevice", { title, device })
          }
        />
      </PageBody>
    </PageShell>
  );
}
