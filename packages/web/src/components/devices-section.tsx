import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { devicesStatusSchema } from "@rome/api-types/devices";
import { NODE_CONSOLE_PATH } from "@rome/api-types/node-console";
import { NodeDeviceCard, NodeDevices, type NodeNavigation } from "@rome-os/node-ui";
import {
  Measure,
  Section,
  SectionHeader,
  SectionHeading,
  SectionTitle,
  SectionDescription,
} from "@rome-os/ui/page";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useThisDevice } from "@/hooks/use-this-device";
import { StatusIndicator } from "@/lib/connection-status";
import { fetchJson } from "@/lib/fetch-json";

export function nodeConsoleUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${NODE_CONSOLE_PATH}`;
}

/** `/settings/devices`, a device's page under it, and `?command=` for one command there. */
export function deviceHref(deviceId: string | null, commandId?: number): string {
  if (deviceId === null) return "/settings/devices";
  const path = `/settings/devices/${encodeURIComponent(deviceId)}`;
  return commandId === undefined ? path : `${path}?command=${commandId}`;
}

/** The linked devices and the service's connection, read every 15 seconds. */
export function useDevicesQuery() {
  const { t } = useTranslation("settings");
  return useQuery({
    queryKey: ["node-devices"],
    refetchInterval: 15_000,
    retry: false,
    queryFn: async ({ signal }) =>
      devicesStatusSchema.parse(
        await fetchJson<unknown>("/api/devices", { signal, fallback: t("devices.loadFailed") }),
      ),
  });
}

export function DevicesSection() {
  const { t, i18n } = useTranslation("settings");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigation = useMemo<NodeNavigation>(
    () => ({ href: deviceHref, navigate: (href) => navigate(href) }),
    [navigate],
  );
  const start = useMutation({
    retry: false,
    mutationFn: () =>
      fetchJson<void>("/api/devices/start", {
        method: "POST",
        fallback: t("devices.startFailed"),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["node-devices"] }),
  });
  const query = useDevicesQuery();
  // A failed poll keeps the last answer, so the page changes only when the service does.
  const data = query.data;
  const connection = data?.connection ?? "unavailable";
  const unavailable = data
    ? ["unavailable", "incompatible", "not_configured", "not_running"].includes(connection)
    : query.isError;
  const devices = data?.devices ?? [];
  const thisDevice = useThisDevice(() => void query.refetch());

  // While the first read is pending, the devices page holds its place without cards.
  if (!unavailable)
    return (
      <NodeDevices
        url={nodeConsoleUrl()}
        devices={devices}
        navigation={navigation}
        locale={i18n.language}
        thisDevice={thisDevice ?? undefined}
        loading={!data}
      />
    );

  // Without a working device service there is no activity to show, so the tab explains how to
  // bring the service back and how to link a computer.
  return (
    <Measure className="space-y-6">
      {/* The Mac app's computer works without Rome's device service. */}
      {thisDevice && (
        <NodeDeviceCard
          device={
            devices.find((device) => device.id === thisDevice.id) ?? {
              id: thisDevice.id,
              name: thisDevice.name,
              platform: thisDevice.platform,
            }
          }
          thisDevice={thisDevice}
          locale={i18n.language}
        />
      )}
      <Section aria-labelledby="devices-title">
        <SectionHeader>
          <SectionHeading>
            <SectionTitle id="devices-title">{t("devices.title")}</SectionTitle>
            <SectionDescription>{t("devices.description")}</SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <Card>
          <CardContent>
            <div className="space-y-2">
              <p className="text-ui">{t("devices.connectionLabel")}</p>
              <StatusIndicator
                status={{
                  label: t(`devices.connection.${connection}`),
                  tone: connection === "incompatible" ? "attention" : "muted",
                }}
              />
            </div>
            <p
              role={connection === "unavailable" ? "alert" : undefined}
              className="mt-4 text-ui text-muted-foreground"
            >
              {t(
                `devices.help.${connection as "unavailable" | "incompatible" | "not_configured" | "not_running"}`,
              )}
            </p>
            {connection === "not_running" && (
              <div className="mt-4">
                <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
                  {t(start.isPending ? "devices.starting" : "devices.start")}
                </Button>
              </div>
            )}
            {start.isError && (
              <p role="alert" className="mt-4 text-ui text-destructive-fg">
                {start.error.message === "not_configured"
                  ? t("devices.help.not_configured")
                  : start.error.message === "incompatible"
                    ? t("devices.help.incompatible")
                    : t("devices.startFailed")}
              </p>
            )}
          </CardContent>
        </Card>
      </Section>
      <Section aria-labelledby="connect-computer-title">
        <SectionHeader>
          <SectionHeading>
            <SectionTitle id="connect-computer-title">{t("devices.setup.title")}</SectionTitle>
            <SectionDescription>{t("devices.setup.description")}</SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <Card>
          <CardContent className="space-y-4">
            <p className="text-ui text-muted-foreground">{t("devices.setup.commandHelp")}</p>
            <pre className="overflow-x-auto rounded-8 bg-muted p-4 font-mono text-ui">
              <code>rome-node connect</code>
            </pre>
            <p className="text-ui text-muted-foreground">{t("devices.setup.access")}</p>
            <Button variant="outline" size="sm" asChild>
              <a
                href="https://github.com/rome-os/rome/blob/main/packages/rome-node-cli/README.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("devices.setup.instructions")}
              </a>
            </Button>
          </CardContent>
        </Card>
      </Section>
    </Measure>
  );
}
