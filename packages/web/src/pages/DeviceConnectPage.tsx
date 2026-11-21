import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/fetch-json";
import { PageBody, PageHeader, PageShell } from "@/shell/PageShell";

interface DeviceLabel {
  title: string;
  summary?: string;
}

/** A device connection as `GET /api/device-connections` lists it, in the fields this page reads. */
interface DeviceConnection {
  capability: string;
  title: string;
  summary: string | null;
  labels?: Record<string, DeviceLabel>;
  device: { name: string | null };
  state: "working" | "off" | "broken";
}

/**
 * The capability's name and what it lets Rome do, by the same rule as the
 * chat's connect card: the guardian's language when the device has it, whole,
 * so the page never pairs a translated name with an English summary.
 */
function wordsOf(connection: DeviceConnection, language: string): DeviceLabel {
  const local = connection.labels?.[language];
  if (local) return local;
  const english = connection.labels?.en;
  const summary = english?.summary ?? connection.summary ?? undefined;
  return { title: english?.title ?? connection.title, ...(summary ? { summary } : {}) };
}

/**
 * Where a connect card's Connect leads for a device capability
 * (`/connections/device/:capability`). The device's own app opens its flow at
 * this path; in a browser the page says what the capability does and that it
 * is turned on on the device, since nothing here connects it.
 */
export default function DeviceConnectPage() {
  const { t, i18n } = useTranslation("settings");
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

  if (query.isPending) {
    return (
      <PageShell>
        <PageBody>
          <p className="text-ui text-muted-foreground">{t("connections.loading")}</p>
        </PageBody>
      </PageShell>
    );
  }

  // Without the list the page cannot say what the capability is, so it says
  // why rather than showing the capability's id as its name.
  if (query.isError) {
    return (
      <PageShell>
        <PageBody>
          <Alert variant="destructive">
            <AlertTitle>{t("connections.errorTitle")}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{query.error.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
              >
                {t("deviceConnect.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        </PageBody>
      </PageShell>
    );
  }

  const ofKind = query.data.connections.filter((c) => c.capability === capability);
  const working = ofKind.find((c) => c.state === "working");
  const first = working ?? ofKind[0];
  const words = first ? wordsOf(first, i18n.language) : { title: capability };
  const title = words.title;
  const device = first?.device.name ?? t("deviceConnect.yourDevice");
  return (
    <PageShell>
      <PageBody>
        <PageHeader title={t("deviceConnect.title", { title })} description={words.summary} />
        <p className="text-ui">
          {working
            ? t("deviceConnect.connected", { title, device })
            : t("deviceConnect.onDevice", { title, device })}
        </p>
        <p className="text-ui text-muted-foreground">
          {t("deviceConnect.notAComputer")}{" "}
          <Link
            to="/settings/devices"
            className="text-foreground underline underline-offset-2 outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
          >
            {t("deviceConnect.devicesLink")}
          </Link>
        </p>
      </PageBody>
    </PageShell>
  );
}
