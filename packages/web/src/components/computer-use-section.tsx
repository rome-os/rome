import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { computerUseStatusSchema } from "@rome/api-types/computer-use";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { fetchJson } from "@/lib/fetch-json";

function relativeTime(value: string, locale: string): string {
  const seconds = Math.min(0, Math.round((Date.parse(value) - Date.now()) / 1_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds > -60) return formatter.format(seconds, "second");
  if (seconds > -3_600) return formatter.format(Math.ceil(seconds / 60), "minute");
  if (seconds > -86_400) return formatter.format(Math.ceil(seconds / 3_600), "hour");
  return formatter.format(Math.ceil(seconds / 86_400), "day");
}

/** One row with the OpenCLI status and how many browsers are connected, for a
 *  `FormRows` group. The per-browser list is rarely needed, so it opens in a
 *  side sheet, which also polls faster while it is open. */
export function ComputerUseRow() {
  const { t, i18n } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["computer-use"],
    refetchInterval: open ? 5_000 : 30_000,
    queryFn: async ({ signal }) =>
      computerUseStatusSchema.parse(
        await fetchJson<unknown>("/api/computer-use", {
          signal,
          fallback: t("advanced.computerUse.loadFailed"),
        }),
      ),
  });
  const data = query.data;
  const daemonUp = !query.isError && data?.daemon.status === "running";
  const connected = query.isError
    ? 0
    : (data?.connections.filter((connection) => connection.status === "connected").length ?? 0);

  return (
    <>
      <FormRow>
        <FormRowHeading>
          <FormRowLabel>{t("advanced.computerUse.title")}</FormRowLabel>
          <FormRowDescription role={query.isError ? "alert" : undefined}>
            {query.isPending
              ? t("advanced.computerUse.loading")
              : query.isError
                ? t("advanced.computerUse.loadFailed")
                : !daemonUp
                  ? t("advanced.computerUse.daemonUnavailable")
                  : t("advanced.computerUse.summary", { count: connected })}
          </FormRowDescription>
        </FormRowHeading>
        <FormRowControl>
          {data && (
            <Badge variant={daemonUp ? "success" : "muted"}>
              {t(`advanced.computerUse.daemon.${daemonUp ? "running" : "unavailable"}`)}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t("advanced.computerUse.details")}
          </Button>
        </FormRowControl>
      </FormRow>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={t("advanced.computerUse.title")}
        widthClassName="w-full max-w-md"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
          <SheetTitle className="flex-1 truncate text-title text-foreground">
            {t("advanced.computerUse.title")}
          </SheetTitle>
          <IconButton
            size="sm"
            label={t("advanced.computerUse.refresh")}
            icon={<RefreshCw />}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          />
          <IconButton
            size="sm"
            label={t("advanced.computerUse.close")}
            icon={<X />}
            onClick={() => setOpen(false)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* The sheet covers the row, so it repeats the request's state. */}
          {query.isPending ? (
            <p role="status" className="mb-4 text-ui text-muted-foreground">
              {t("advanced.computerUse.loading")}
            </p>
          ) : query.isError ? (
            <p role="alert" className="mb-4 text-ui text-destructive-fg">
              {t("advanced.computerUse.loadFailed")}
            </p>
          ) : !daemonUp ? (
            <p className="mb-4 text-ui text-muted-foreground">
              {t("advanced.computerUse.daemonUnavailable")}
            </p>
          ) : null}
          {data && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ui">OpenCLI</span>
              {data.daemon.version && (
                <span className="text-aux text-muted-foreground">v{data.daemon.version}</span>
              )}
            </div>
          )}
          {data &&
            (data.connections.length === 0 ? (
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
            ))}
          <Button asChild variant="link" size="sm" className="mt-4 px-0">
            <a
              href="https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("advanced.computerUse.installExtension")}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </Button>
        </div>
      </Sheet>
    </>
  );
}
