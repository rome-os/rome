import { useQuery } from "@tanstack/react-query";
import { devicesStatusSchema } from "@rome/api-types/devices";
import {
  Measure,
  Section,
  SectionHeader,
  SectionHeading,
  SectionTitle,
  SectionDescription,
  SectionActions,
} from "@rome-os/ui/page";
import { Monitor, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusIndicator } from "@/lib/connection-status";
import { fetchJson } from "@/lib/fetch-json";

export function DevicesSection() {
  const { t, i18n } = useTranslation("settings");
  const query = useQuery({
    queryKey: ["node-devices"],
    refetchInterval: 15_000,
    retry: false,
    queryFn: async ({ signal }) =>
      devicesStatusSchema.parse(
        await fetchJson<unknown>("/api/devices", { signal, fallback: t("devices.loadFailed") }),
      ),
  });
  const data = query.isError ? undefined : query.data;
  const connection = data?.connection ?? "unavailable";
  const unavailable = ["unavailable", "incompatible", "not_configured", "not_running"].includes(
    connection,
  );
  const devices = data?.devices ?? [];
  const connected = devices.filter((device) => device.status === "connected").length;
  const unknown = devices.filter((device) => device.status === "unknown").length;
  const total = devices.filter((device) => device.status !== "revoked").length;

  return (
    <Measure>
      <Section aria-labelledby="devices-title">
        <SectionHeader>
          <SectionHeading>
            <SectionTitle id="devices-title">{t("devices.title")}</SectionTitle>
            <SectionDescription>{t("devices.description")}</SectionDescription>
          </SectionHeading>
          <SectionActions>
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              {t("devices.refresh")}
            </Button>
          </SectionActions>
        </SectionHeader>
        {query.isPending ? (
          <p role="status" className="text-ui text-muted-foreground">
            {t("devices.loading")}
          </p>
        ) : (
          <Card>
            <CardContent>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-2">
                  <p className="text-ui">{t("devices.connectionLabel")}</p>
                  <StatusIndicator
                    status={{
                      label: t(`devices.connection.${connection}`),
                      tone:
                        connection === "online"
                          ? "success"
                          : ["retrying", "revoked", "superseded", "incompatible"].includes(
                                connection,
                              )
                            ? "attention"
                            : "muted",
                    }}
                  />
                </div>
                <div className="space-y-2 text-right" aria-live="polite">
                  <p className="text-ui">
                    {unavailable || (unknown > 0 && connected === 0)
                      ? "—"
                      : t(unknown ? "devices.connectedAtLeast" : "devices.connectedCount", {
                          count: connected,
                        })}
                  </p>
                  {!unavailable && (
                    <p className="text-aux text-muted-foreground">
                      {t("devices.totalCount", { count: total })}
                    </p>
                  )}
                </div>
              </div>
              {unavailable ? (
                <p
                  role={connection === "unavailable" ? "alert" : undefined}
                  className="mt-4 text-ui text-muted-foreground"
                >
                  {t(
                    `devices.help.${connection as "unavailable" | "incompatible" | "not_configured" | "not_running"}`,
                  )}
                </p>
              ) : devices.length === 0 ? (
                <p className="mt-4 text-ui text-muted-foreground">{t("devices.empty")}</p>
              ) : (
                <ul className="mt-6 divide-y divide-border" aria-label={t("devices.title")}>
                  {devices.map((device) => (
                    <li
                      key={device.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Monitor
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="break-words text-ui">{device.name}</p>
                          {device.platform && (
                            <p className="text-aux text-muted-foreground">{device.platform}</p>
                          )}
                        </div>
                      </div>
                      <StatusIndicator
                        status={{
                          label: t(`devices.status.${device.status}`),
                          tone:
                            device.status === "connected"
                              ? "success"
                              : device.status === "unknown"
                                ? "attention"
                                : "muted",
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {unknown > 0 && (
                <p className="mt-4 text-aux text-muted-foreground">
                  {t("devices.unknownCount", { count: unknown })}
                </p>
              )}
              {!unavailable && data && (
                <p className="mt-4 text-aux text-muted-foreground">
                  {t("devices.checkedAt", {
                    time: new Date(data.checkedAt).toLocaleTimeString(i18n.language),
                  })}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </Section>
    </Measure>
  );
}
