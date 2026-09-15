import { useQuery } from "@tanstack/react-query";
import { computerUseStatusSchema } from "@rome/api-types/computer-use";
import { ExternalLink, Monitor, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchJson } from "@/lib/fetch-json";

function relativeTime(value: string, locale: string): string {
  const seconds = Math.min(0, Math.round((Date.parse(value) - Date.now()) / 1_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds > -60) return formatter.format(seconds, "second");
  if (seconds > -3_600) return formatter.format(Math.ceil(seconds / 60), "minute");
  if (seconds > -86_400) return formatter.format(Math.ceil(seconds / 3_600), "hour");
  return formatter.format(Math.ceil(seconds / 86_400), "day");
}

export function ComputerUseSection() {
  const { t, i18n } = useTranslation("settings");
  const query = useQuery({
    queryKey: ["computer-use"],
    refetchInterval: 5_000,
    queryFn: async ({ signal }) =>
      computerUseStatusSchema.parse(
        await fetchJson<unknown>("/api/computer-use", {
          signal,
          fallback: t("advanced.computerUse.loadFailed"),
        }),
      ),
  });
  const data = query.data;

  return (
    <section aria-labelledby="computer-use-title">
      <div className="flex items-center justify-between gap-4">
        <h2 id="computer-use-title" className="text-section text-foreground">
          {t("advanced.computerUse.title")}
        </h2>
        <Button
          variant="outline"
          size="xs"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {t("advanced.computerUse.refresh")}
        </Button>
      </div>
      <p className="mt-1 mb-4 text-body text-muted-foreground">
        {t("advanced.computerUse.description")}
      </p>
      {query.isError && (
        <p role="alert" className="mb-4 text-ui text-destructive-fg">
          {t("advanced.computerUse.loadFailed")}
        </p>
      )}
      {query.isPending ? (
        <p role="status" className="text-ui text-muted-foreground">
          {t("advanced.computerUse.loading")}
        </p>
      ) : data ? (
        <Card>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ui">OpenCLI</span>
              {data.daemon.version && (
                <span className="text-aux text-muted-foreground">v{data.daemon.version}</span>
              )}
              <Badge
                variant={!query.isError && data.daemon.status === "running" ? "success" : "muted"}
              >
                {t(
                  `advanced.computerUse.daemon.${query.isError ? "unavailable" : data.daemon.status}`,
                )}
              </Badge>
            </div>
            {(data.daemon.status === "unavailable" || query.isError) && (
              <p className="mt-2 text-ui text-muted-foreground">
                {t("advanced.computerUse.daemonUnavailable")}
              </p>
            )}
            {data.connections.length === 0 ? (
              <p className="mt-4 text-ui text-muted-foreground">
                {t("advanced.computerUse.empty")}
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-border">
                {data.connections.map((connection) => {
                  const status = query.isError ? "unknown" : connection.status;
                  return (
                    <li
                      key={connection.id}
                      className="flex flex-wrap items-start justify-between gap-3 py-4 first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <Monitor
                          className="mt-1 size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-all text-ui">
                              {connection.name ??
                                t("advanced.computerUse.browser", { id: connection.id })}
                            </span>
                            <Badge variant={status === "connected" ? "success" : "muted"}>
                              {t(`advanced.computerUse.status.${status}`)}
                            </Badge>
                          </div>
                          <p className="mt-1 break-all text-aux text-muted-foreground">
                            {t("advanced.computerUse.profile", { id: connection.id })}
                            {connection.version &&
                              ` · ${t("advanced.computerUse.extensionVersion", { version: connection.version })}`}
                          </p>
                        </div>
                      </div>
                      <div className="text-aux text-muted-foreground">
                        {t("advanced.computerUse.lastSeen")}{" "}
                        {connection.lastSeenAt ? (
                          <time
                            dateTime={connection.lastSeenAt}
                            title={new Date(connection.lastSeenAt).toLocaleString(i18n.language)}
                          >
                            {relativeTime(connection.lastSeenAt, i18n.language)}
                          </time>
                        ) : (
                          t("advanced.computerUse.notReported")
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
      <Button asChild variant="link" size="sm" className="mt-2 px-0">
        <a
          href="https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("advanced.computerUse.installExtension")}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </Button>
    </section>
  );
}
