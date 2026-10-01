import { wechatAppStatusSchema, type WechatAppStatus } from "@rome/api-types/wechat-app";
import { Spinner } from "@rome-os/ui/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { fetchJson } from "@/lib/fetch-json";
import DesktopPage from "./DesktopPage";

const QUERY_KEY = ["wechat-app"] as const;

/** While a download or start runs, poll fast enough to show the client soon
 *  after it opens; otherwise just notice a client that stopped. */
function pollInterval(status: WechatAppStatus | undefined): number {
  return status?.state === "installing" || status?.state === "starting" ? 2_000 : 30_000;
}

/** `/desktop/wechat`: WeChat's own desktop. Opening the page starts an installed
 *  client that is not running; until it runs, the page says what is missing and
 *  offers the button that fixes it. */
export default function WechatDesktopPage() {
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async ({ signal }) =>
      wechatAppStatusSchema.parse(
        await fetchJson<unknown>("/api/wechat/app", {
          signal,
          fallback: t("wechatApp.loadFailed"),
        }),
      ),
    refetchInterval: (query) => pollInterval(query.state.data),
  });
  const action = useMutation({
    mutationFn: async (kind: "install" | "start") =>
      wechatAppStatusSchema.parse(
        await fetchJson<unknown>(`/api/wechat/app/${kind}`, {
          method: "POST",
          fallback: t(kind === "install" ? "wechatApp.installFailed" : "wechatApp.startFailed"),
        }),
      ),
    onSuccess: (next) => queryClient.setQueryData(QUERY_KEY, next),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const data = status.data;
  // Opening the page starts an installed client that is not running, once per
  // visit. A start that failed waits for the guardian, so it cannot loop.
  const opened = useRef(false);
  const stopped = data?.state === "stopped" && !data.error;
  useEffect(() => {
    if (!stopped || opened.current) return;
    opened.current = true;
    action.mutate("start");
  }, [stopped, action.mutate]);
  // The desktop stays on view while the client starts, under a banner. The VNC
  // client does not reconnect, and WeChat's display may not be up while the
  // client starts, so the desktop is keyed by state: reaching running opens a
  // fresh connection, and the login window shows the moment it appears.
  if ((data?.state === "running" && !data.sharedDesktop) || data?.state === "starting") {
    return (
      <div className="relative">
        <DesktopPage key={data.state} name="wechat" />
        {data.state === "starting" ? (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-ui text-foreground shadow-sm">
              <Spinner size="sm" label={t("wechatApp.starting.title")} />
              <span aria-hidden="true">{t("wechatApp.starting.title")}</span>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const panel = (children: React.ReactNode) => (
    <div className="flex h-[var(--rome-mobile-content-height)] items-center justify-center md:h-dvh">
      <EmptyState>{children}</EmptyState>
    </div>
  );

  if (!data) {
    if (status.isError) {
      return panel(
        <>
          <EmptyStateTitle>{t("wechatApp.loadFailed")}</EmptyStateTitle>
          <EmptyStateDescription>{status.error.message}</EmptyStateDescription>
        </>,
      );
    }
    return panel(
      <EmptyStateIcon>
        <Spinner label={t("wechatApp.loading")} />
      </EmptyStateIcon>,
    );
  }

  if (data.state === "running") {
    return panel(
      <>
        <EmptyStateTitle>{t("wechatApp.sharedDesktop.title")}</EmptyStateTitle>
        <EmptyStateDescription>{t("wechatApp.sharedDesktop.description")}</EmptyStateDescription>
        <EmptyStateAction>
          <Button asChild>
            <Link to="/desktop">{t("wechatApp.sharedDesktop.action")}</Link>
          </Button>
        </EmptyStateAction>
      </>,
    );
  }

  if (data.state === "unavailable") {
    return panel(
      <>
        <EmptyStateTitle>{t("wechatApp.unavailable.title")}</EmptyStateTitle>
        <EmptyStateDescription>{t("wechatApp.unavailable.description")}</EmptyStateDescription>
      </>,
    );
  }

  if (data.state === "installing") {
    return panel(
      <>
        <EmptyStateIcon>
          <Spinner label={t("wechatApp.installing.title")} />
        </EmptyStateIcon>
        <EmptyStateTitle>{t("wechatApp.installing.title")}</EmptyStateTitle>
        <EmptyStateDescription>{t("wechatApp.installing.description")}</EmptyStateDescription>
      </>,
    );
  }

  // absent or stopped: say what is missing, why the last try failed, and offer
  // the one button that fixes it.
  const kind = data.state === "absent" ? "install" : "start";
  const failure = data.error ?? (action.isError ? action.error.message : undefined);
  return panel(
    <>
      <EmptyStateTitle>{t(`wechatApp.${data.state}.title`)}</EmptyStateTitle>
      <EmptyStateDescription>
        {failure
          ? t(`wechatApp.${data.state}.failed`, { error: failure })
          : t(`wechatApp.${data.state}.description`)}
      </EmptyStateDescription>
      <EmptyStateAction>
        <Button disabled={action.isPending} onClick={() => action.mutate(kind)}>
          {failure ? t("wechatApp.retry") : t(`wechatApp.${data.state}.action`)}
        </Button>
      </EmptyStateAction>
    </>,
  );
}
