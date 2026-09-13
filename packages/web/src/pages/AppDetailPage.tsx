import {
  ArrowLeft,
  ExternalLink,
  GitFork,
  Globe,
  MessageCircle,
  MessageSquare,
  Power,
  Trash2,
  TriangleAlert,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { AppArtifactDetails, AppReadmeResponse, InstalledAppCard } from "@rome/api-types/apps";
import Markdown from "@/components/markdown";
import { AppRemixDialog, canRemixApp } from "@/components/app-remix-dialog";
import { TileIcon, getStatusDot } from "@/components/app-tile-icon";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { getHostAppRoute } from "@/lib/auth-routing";
import { fetchJson } from "@/lib/fetch-json";
import { useAppsList } from "@/hooks/use-apps";
import { useAppLifecycle } from "@/hooks/use-app-lifecycle";
import { PageShell, PageBody, PageHeader } from "@/shell/PageShell";

type CapabilityKey = keyof AppArtifactDetails;

const CAPABILITY_KEYS: CapabilityKey[] = ["agents", "actions", "skills", "hooks"];

// One row in the Manage section: icon, label + hint, and the control that
// performs the action on the right.
interface ManageRowProps {
  icon: LucideIcon;
  title: string;
  description: string;
  control: ReactNode;
}

function ManageRow({ icon: Icon, title, description, control }: ManageRowProps) {
  return (
    <ListRow className="flex-wrap">
      <Icon className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
      <ListRowContent>
        <ListRowTitle>{title}</ListRowTitle>
        <ListRowDescription>{description}</ListRowDescription>
      </ListRowContent>
      <div className="shrink-0">{control}</div>
    </ListRow>
  );
}

// Details view for one installed app — the management hub the launcher tiles
// point at: identity header, every lifecycle action as a visible control (the
// tile menu is a shortcut to the same things), the full
// agents/actions/skills/hooks inventory, and the bundle's README when it
// ships one.
export default function AppDetailPage() {
  const { t } = useTranslation("apps");
  const navigate = useNavigate();
  const { appId = "" } = useParams();
  const [remixOpen, setRemixOpen] = useState(false);
  // Reuse the cached list rather than a per-app endpoint — a deep link just
  // triggers the list fetch, which already carries capabilityDetails. The
  // list-only hook keeps this page from firing the expensive updates probe
  // it never reads.
  const { apps, error: appsError } = useAppsList();
  const app = apps?.find((a) => a.id === appId) ?? null;
  // probeUpdates: false — same contract. The update banner renders only from
  // candidates a previous apps-grid visit left in the query cache.
  const lifecycle = useAppLifecycle(apps, {
    probeUpdates: false,
    onUninstalled: () => navigate("/apps"),
  });

  // README is advisory: a fetch failure or an app without one simply hides
  // the section, so no error state is surfaced for it.
  const { data: readmeData } = useQuery({
    queryKey: ["apps", "readme", appId],
    enabled: appId.length > 0,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      fetchJson<AppReadmeResponse>(`/api/app-readmes/${encodeURIComponent(appId)}`, {
        signal,
        fallback: t("installed.errors.loadFailed"),
      }),
  });
  const readme = readmeData?.readme ?? null;

  const startChatWithAgent = (app: InstalledAppCard, agentName: string) => {
    navigate("/chat", {
      state: {
        agentMention: {
          appId: app.id,
          appLabel: app.displayName,
          agentName: `${app.id}:${agentName}`,
        },
      },
    });
  };

  const accessModeLabel = (app: InstalledAppCard): string => {
    const mode = app.accessMode ?? (app.isPublic ? "public" : "private");
    if (mode === "public") return t("installed.accessDialog.publicTitle");
    if (mode === "cloud-email") return t("installed.accessDialog.cloudEmailTitle");
    return t("installed.accessDialog.privateTitle");
  };

  const renderManageSection = (app: InstalledAppCard) => {
    const canChatToUpdate = app.projectPath !== null;
    const hasManageRow =
      app.canToggle ||
      canChatToUpdate ||
      app.canManagePublicAccess ||
      app.canPublish ||
      app.canUninstall;
    if (!hasManageRow) return null;

    const busy = lifecycle.lifecycleBusy || lifecycle.accessBusy;
    const isActing = lifecycle.isAppActing(app.id);

    return (
      <section
        aria-label={t("detail.manage")}
        className="rounded-12 border border-border bg-surface"
      >
        {/* px-3 is `--row-px-md`, so the title starts where the rows below it do. */}
        <div className="border-b border-border-subtle px-3 py-3">
          <h2 className="text-section text-foreground">{t("detail.manage")}</h2>
        </div>
        <List>
          {app.canToggle ? (
            <ManageRow
              icon={Power}
              title={t("detail.enabledTitle")}
              description={t("detail.enabledHint")}
              control={
                <Switch
                  checked={app.isEnabled}
                  onCheckedChange={() => lifecycle.toggle(app)}
                  disabled={busy}
                  aria-label={t("detail.enabledTitle")}
                />
              }
            />
          ) : null}
          {canChatToUpdate ? (
            <ManageRow
              icon={MessageCircle}
              title={t("detail.chatTitle")}
              description={t("detail.chatHint")}
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => lifecycle.startChatToUpdate(app)}
                >
                  {t("installed.chatToUpdate")}
                </Button>
              }
            />
          ) : null}
          {app.canManagePublicAccess ? (
            <ManageRow
              icon={Globe}
              title={t("installed.access")}
              description={accessModeLabel(app)}
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => lifecycle.requestAccess(app)}
                  disabled={busy}
                >
                  {t("detail.change")}
                </Button>
              }
            />
          ) : null}
          {app.canPublish ? (
            <ManageRow
              icon={Upload}
              title={t("detail.publishTitle")}
              description={t("detail.publishHint", { version: app.version })}
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => lifecycle.requestPublish(app)}
                  disabled={busy}
                >
                  {isActing ? t("installed.publishing") : t("installed.publish")}
                </Button>
              }
            />
          ) : null}
          {app.canUninstall ? (
            <>
              <ManageRow
                icon={Trash2}
                title={t("installed.uninstall")}
                description={t("detail.uninstallHint")}
                control={
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => lifecycle.requestUninstall(app, false)}
                    disabled={busy}
                  >
                    {t("installed.uninstall")}
                  </Button>
                }
              />
              <ManageRow
                icon={Trash2}
                title={t("installed.uninstallPurge")}
                description={t("detail.uninstallPurgeHint")}
                control={
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => lifecycle.requestUninstall(app, true)}
                    disabled={busy}
                  >
                    {t("installed.uninstallPurge")}
                  </Button>
                }
              />
            </>
          ) : null}
        </List>
      </section>
    );
  };

  const renderHeaderActions = (app: InstalledAppCard) => {
    const embeddedHref = app.hasFrontend && app.href ? app.href : null;
    const targetHref = embeddedHref ?? getHostAppRoute(app.id);
    const remixable = canRemixApp(app);
    if (!targetHref && !app.fullHref && !remixable) return null;
    return (
      <>
        {targetHref ? (
          <Button asChild size="sm">
            <Link to={targetHref}>{t("detail.open")}</Link>
          </Button>
        ) : null}
        {app.fullHref ? (
          <Button asChild variant="outline" size="sm">
            <Link to={app.fullHref}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t("installed.openFullTitle")}
            </Link>
          </Button>
        ) : null}
        {remixable ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setRemixOpen(true)}>
            <GitFork className="h-3.5 w-3.5" aria-hidden />
            {t("installed.remix")}
          </Button>
        ) : null}
      </>
    );
  };

  const candidate = app ? lifecycle.freshCandidate(app) : undefined;

  return (
    <PageShell>
      <PageBody>
        <Link
          to="/apps"
          className="inline-flex items-center gap-1 self-start text-ui text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("detail.back")}
        </Link>

        {appsError ? (
          <p className="rounded-8 bg-destructive-bg px-4 py-3 text-ui text-destructive-fg">
            {appsError.message || t("installed.errors.loadFailed")}
          </p>
        ) : null}

        {apps === null ? (
          // A hard list failure with no cached data is terminal, not loading —
          // the banner above already explains it, so don't shimmer forever.
          appsError ? null : (
            <div className="flex flex-col gap-4" aria-busy>
              <div className="flex items-start gap-4">
                <Skeleton className="h-11 w-11 rounded-12" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
              </div>
              <Skeleton className="h-40 w-full rounded-12" />
            </div>
          )
        ) : !app ? (
          <p className="text-ui text-subtle-foreground">{t("detail.notFound")}</p>
        ) : (
          <>
            <PageHeader
              leading={
                <TileIcon
                  kind="image"
                  displayName={app.displayName}
                  iconUrl={app.iconUrl}
                  muted={app.status === "disabled"}
                />
              }
              title={app.displayName}
              titleAside={
                <span className="flex shrink-0 items-center gap-2 text-aux text-muted-foreground">
                  <span
                    className={cn(
                      "inline-block h-1.5 w-1.5 rounded-full",
                      getStatusDot(app.status),
                    )}
                  />
                  {t(`status.${app.status}`)}
                </span>
              }
              description={
                <>
                  <span className="block text-subtle-foreground">
                    {app.id} &middot; v{app.version}
                  </span>
                  {app.description ? (
                    <p className="mt-2 text-body text-muted-foreground">{app.description}</p>
                  ) : null}
                </>
              }
              actions={renderHeaderActions(app)}
            />

            {app.error ? (
              <p className="rounded-8 bg-destructive-bg px-4 py-3 text-ui text-destructive-fg">
                {app.error}
              </p>
            ) : null}

            {candidate ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-12 border border-success/40 bg-success/10 px-4 py-3">
                <p className="text-ui text-foreground">
                  {t("detail.updateBanner", {
                    version: candidate.availableVersion,
                  })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => lifecycle.upgrade(app)}
                  disabled={lifecycle.lifecycleBusy}
                >
                  {lifecycle.isAppActing(app.id) ? t("installed.upgrading") : t("detail.update")}
                </Button>
              </div>
            ) : null}

            {renderManageSection(app)}

            <div className="grid gap-4 sm:grid-cols-2">
              {CAPABILITY_KEYS.map((key) => {
                const items = app.capabilityDetails[key];
                const label = t(`capabilities.${key}`);
                return (
                  <section
                    key={key}
                    aria-label={label}
                    className="flex flex-col rounded-12 border border-border bg-surface"
                  >
                    <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
                      <h2 className="text-section text-foreground">{label}</h2>
                      <span className="rounded-full bg-primary/10 px-2 py-1 text-badge text-primary">
                        {items.length}
                      </span>
                    </div>
                    {items.length > 0 ? (
                      <ul className="divide-y divide-border-subtle">
                        {items.map((item) => (
                          <li
                            key={`${item.name}-${item.description}`}
                            className="flex items-start gap-2 px-4 py-3"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                {item.loadError ? (
                                  <TriangleAlert
                                    className="h-3.5 w-3.5 shrink-0 text-warning-fg"
                                    aria-hidden
                                  />
                                ) : null}
                                <p className="min-w-0 break-words text-ui text-foreground">
                                  {item.name}
                                </p>
                                {item.loadError ? (
                                  <span className="ml-auto shrink-0 rounded-full border border-warning-border bg-warning-bg px-2 py-1 text-badge text-warning-fg">
                                    {t("installed.skillLoadFailed")}
                                  </span>
                                ) : null}
                              </div>
                              <p
                                className={cn(
                                  "mt-1 break-words text-aux",
                                  item.loadError ? "text-warning-fg" : "text-muted-foreground",
                                )}
                              >
                                {item.loadError ?? item.description}
                              </p>
                            </div>
                            {key === "agents" ? (
                              <IconButton
                                size="xs"
                                label={t("installed.chatWithAgentAria", {
                                  agent: item.name,
                                })}
                                icon={<MessageSquare aria-hidden />}
                                onClick={() => startChatWithAgent(app, item.name)}
                                className="text-subtle-foreground hover:text-foreground"
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="px-4 py-4 text-aux text-subtle-foreground">
                        {t("installed.noCapabilities", {
                          label: label.toLowerCase(),
                        })}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>

            {readme ? (
              <section
                aria-label={t("detail.readme")}
                className="rounded-12 border border-border bg-surface"
              >
                <div className="border-b border-border-subtle px-4 py-3">
                  <h2 className="text-section text-foreground">{t("detail.readme")}</h2>
                </div>
                <div className="px-4 py-4">
                  <Markdown className="text-foreground">{readme}</Markdown>
                </div>
              </section>
            ) : null}
          </>
        )}

        {lifecycle.dialogs}
        <AppRemixDialog app={remixOpen ? app : null} onClose={() => setRemixOpen(false)} />
      </PageBody>
    </PageShell>
  );
}
