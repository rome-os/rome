import { ArrowLeft, ExternalLink, GitFork, MessageSquare, TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeaderNav,
  PageHeading,
  PageTitle,
} from "@rome-os/ui/page";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import type { AppArtifactDetails, AppReadmeResponse, InstalledAppCard } from "@rome/api-types/apps";
import Markdown from "@/components/markdown";
import { AppRemixDialog, canRemixApp } from "@/components/app-remix-dialog";
import { TileIcon, getStatusDot } from "@/components/app-tile-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { List, ListRow, ListRowContent } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { getHostAppRoute } from "@/lib/auth-routing";
import { fetchJson } from "@/lib/fetch-json";
import { useAppsList, useStoreListingVersion } from "@/hooks/use-apps";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useAppLifecycle } from "@/hooks/use-app-lifecycle";

type CapabilityKey = keyof AppArtifactDetails;

const CAPABILITY_KEYS: CapabilityKey[] = ["agents", "actions", "skills", "hooks"];

const STATUS_BADGE = {
  active: "success",
  disabled: "muted",
  failed: "destructive",
} as const satisfies Record<InstalledAppCard["status"], string>;

/*
 * The body runs as one column until its own width fits a reading column beside
 * the manage rail. A container query rather than a viewport breakpoint, because
 * the nav sidebar's width decides how much of the viewport the page gets.
 */
const BODY_GRID = "grid items-start gap-6 @4xl:grid-cols-[minmax(0,1fr)_22rem]";

// A titled block in the details column: the heading row carries the label and
// whatever summarizes the block, and the body sits under a hairline.
function Panel({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn("overflow-hidden rounded-12 border border-border bg-surface", className)}
    >
      {/* px-3 is `--row-px-md`, so the title starts where the rows below it do. */}
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        <h2 id={headingId} className="text-section text-foreground">
          {title}
        </h2>
        {aside}
      </div>
      {children ? <div className="border-t border-border-subtle">{children}</div> : null}
    </section>
  );
}

// An action that removes the app: its label and consequence, then the button
// under them. The button's label is too long to share a row with the text in
// the rail's width, so this row stacks where a FormRow would not.
function DestructiveRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-4">
      <div className="flex flex-col gap-1">
        <p className="text-ui text-foreground">{title}</p>
        <p className="text-aux text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

// Details view for one installed app — the management hub the launcher tiles
// point at: identity header with the app's own pitch, every lifecycle action
// as a visible control in the manage rail (the tile menu is a shortcut to the
// same things), the full agents/actions/skills/hooks inventory, and the
// bundle's README when it ships one.
export default function AppDetailPage() {
  const { t } = useTranslation("apps");
  const navigate = useNavigate();
  const { appId = "" } = useParams();
  const [remixOpen, setRemixOpen] = useState(false);
  const enabledSwitchId = useId();
  const manageHeadingId = useId();
  // Reuse the cached list rather than a per-app endpoint — a deep link just
  // triggers the list fetch, which already carries capabilityDetails. The
  // list-only hook keeps this page from firing the expensive updates probe
  // it never reads.
  const { apps, error: appsError } = useAppsList();
  const app = apps?.find((a) => a.id === appId) ?? null;
  useDocumentTitle(app?.displayName ?? null);
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
  const storeListing = useStoreListingVersion(appId, { enabled: app?.canPublish === true });

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
    // The row's hint speaks of the source project, so it stays with apps that have one.
    const hasSourceProject = app.projectPath !== null;
    const hasSettingRow =
      app.canToggle || hasSourceProject || app.canManagePublicAccess || app.canPublish;
    if (!hasSettingRow && !app.canUninstall) return null;

    const busy = lifecycle.lifecycleBusy || lifecycle.accessBusy;
    const isActing = lifecycle.isAppActing(app.id);

    // The heading heads whichever card comes first, so the rail's top edge
    // lines up with the first panel beside it. px-4 is FormRow's inset.
    const heading = (
      <div className="flex min-h-12 items-center px-4 py-2">
        <h2 id={manageHeadingId} className="text-section text-foreground">
          {t("detail.manage")}
        </h2>
      </div>
    );

    return (
      <section aria-labelledby={manageHeadingId} className="flex min-w-0 flex-col gap-4">
        {hasSettingRow ? (
          <div className="divide-y divide-border-subtle overflow-hidden rounded-12 border border-border bg-surface">
            {heading}
            {app.canToggle ? (
              <FormRow>
                <FormRowHeading>
                  <FormRowLabel htmlFor={enabledSwitchId}>{t("detail.enabledTitle")}</FormRowLabel>
                  <FormRowDescription>{t("detail.enabledHint")}</FormRowDescription>
                </FormRowHeading>
                <FormRowControl>
                  <Switch
                    id={enabledSwitchId}
                    checked={app.isEnabled}
                    onCheckedChange={() => lifecycle.toggle(app)}
                    disabled={busy}
                  />
                </FormRowControl>
              </FormRow>
            ) : null}
            {app.canManagePublicAccess ? (
              <FormRow>
                <FormRowHeading>
                  <FormRowLabel>{t("installed.access")}</FormRowLabel>
                  <FormRowDescription>{accessModeLabel(app)}</FormRowDescription>
                </FormRowHeading>
                <FormRowControl>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => lifecycle.requestAccess(app)}
                    disabled={busy}
                  >
                    {t("detail.change")}
                  </Button>
                </FormRowControl>
              </FormRow>
            ) : null}
            {hasSourceProject ? (
              <FormRow>
                <FormRowHeading>
                  <FormRowLabel>{t("installed.chatWithApp")}</FormRowLabel>
                  <FormRowDescription>{t("detail.chatHint")}</FormRowDescription>
                </FormRowHeading>
                <FormRowControl>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("installed.chatWithApp")}
                    onClick={() => lifecycle.chatWithApp(app)}
                  >
                    {t("detail.open")}
                  </Button>
                </FormRowControl>
              </FormRow>
            ) : null}
            {app.canPublish ? (
              <FormRow>
                <FormRowHeading>
                  <FormRowLabel>{t("detail.publishTitle")}</FormRowLabel>
                  <FormRowDescription>
                    {storeListing === null
                      ? t("detail.publishHint", { version: app.version })
                      : storeListing.published
                        ? t("detail.publishHintListed", {
                            version: app.version,
                            storeVersion: storeListing.version,
                          })
                        : t("detail.publishHintUnlisted", { version: app.version })}
                  </FormRowDescription>
                </FormRowHeading>
                <FormRowControl>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => lifecycle.requestPublish(app)}
                    disabled={busy}
                  >
                    {isActing ? t("installed.publishing") : t("installed.publish")}
                  </Button>
                </FormRowControl>
              </FormRow>
            ) : null}
          </div>
        ) : null}
        {app.canUninstall ? (
          // Its own block with a destructive edge, so removing the app never
          // reads as one more setting in the list above.
          <div className="divide-y divide-border-subtle overflow-hidden rounded-12 border border-destructive-border bg-surface">
            {hasSettingRow ? null : heading}
            <DestructiveRow
              title={t("installed.uninstall")}
              description={t("detail.uninstallHint")}
            >
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => lifecycle.requestUninstall(app, false)}
                disabled={busy}
              >
                {t("installed.uninstall")}
              </Button>
            </DestructiveRow>
            <DestructiveRow
              title={t("installed.uninstallPurge")}
              description={t("detail.uninstallPurgeHint")}
            >
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => lifecycle.requestUninstall(app, true)}
                disabled={busy}
              >
                {t("installed.uninstallPurge")}
              </Button>
            </DestructiveRow>
          </div>
        ) : null}
      </section>
    );
  };

  const renderHeaderActions = (app: InstalledAppCard) => {
    const embeddedHref = app.hasFrontend && app.href ? app.href : null;
    const targetHref = embeddedHref ?? getHostAppRoute(app.id);
    const remixable = canRemixApp(app);
    if (!targetHref && !app.fullHref && !remixable) return null;
    return (
      // PageActions keeps its intrinsic width so it does not shrink beside the
      // heading. Capped at the header's width, three actions wrap on a phone
      // instead of running off the screen.
      <PageActions className="max-w-full">
        {app.fullHref ? (
          <Button asChild variant="outline">
            <Link to={app.fullHref}>
              <ExternalLink data-icon="inline-start" aria-hidden />
              {t("installed.openFullTitle")}
            </Link>
          </Button>
        ) : null}
        {remixable ? (
          <Button type="button" variant="outline" onClick={() => setRemixOpen(true)}>
            <GitFork data-icon="inline-start" aria-hidden />
            {t("installed.remix")}
          </Button>
        ) : null}
        {targetHref ? (
          <Button asChild className="min-w-24">
            <Link to={targetHref}>{t("detail.open")}</Link>
          </Button>
        ) : null}
      </PageActions>
    );
  };

  const renderCapability = (app: InstalledAppCard, key: CapabilityKey) => {
    const items = app.capabilityDetails[key];
    const label = t(`capabilities.${key}`);
    const count = (
      <Badge variant="muted" className="tabular-nums">
        {items.length}
      </Badge>
    );
    if (items.length === 0) {
      return (
        <Panel
          key={key}
          title={label}
          aside={
            <>
              {count}
              <p className="ml-auto text-aux text-subtle-foreground">
                {t("installed.noCapabilities", { label: label.toLowerCase() })}
              </p>
            </>
          }
        />
      );
    }
    return (
      <Panel key={key} title={label} aside={count}>
        <List asChild>
          <ul>
            {items.map((item) => (
              <ListRow asChild key={`${item.name}-${item.description}`} className="items-start">
                <li>
                  <ListRowContent className="flex flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {item.loadError ? (
                        <TriangleAlert className="size-3.5 shrink-0 text-warning-fg" aria-hidden />
                      ) : null}
                      <p className="min-w-0 break-words text-ui font-medium text-foreground">
                        {item.name}
                      </p>
                      {item.loadError ? (
                        <Badge variant="warning" className="ml-auto shrink-0">
                          {t("installed.skillLoadFailed")}
                        </Badge>
                      ) : null}
                    </div>
                    <p
                      className={cn(
                        "break-words text-aux",
                        item.loadError ? "text-warning-fg" : "text-muted-foreground",
                      )}
                    >
                      {item.loadError ?? item.description}
                    </p>
                  </ListRowContent>
                  {key === "agents" ? (
                    <IconButton
                      size="sm"
                      label={t("installed.chatWithAgentAria", { agent: item.name })}
                      icon={<MessageSquare aria-hidden />}
                      onClick={() => startChatWithAgent(app, item.name)}
                      className="-my-1 text-muted-foreground hover:text-foreground"
                    />
                  ) : null}
                </li>
              </ListRow>
            ))}
          </ul>
        </List>
      </Panel>
    );
  };

  const candidate = app ? lifecycle.freshCandidate(app) : undefined;

  const backLink = (
    <PageHeaderNav>
      <Link
        to="/apps"
        className="inline-flex items-center gap-1 text-ui text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("detail.back")}
      </Link>
    </PageHeaderNav>
  );

  const loadError = appsError ? (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden />
      <AlertDescription>{appsError.message || t("installed.errors.loadFailed")}</AlertDescription>
    </Alert>
  ) : null;

  const renderBody = () => {
    if (apps === null) {
      // A hard list failure with no cached data is terminal, not loading —
      // the banner already explains it, so don't shimmer forever.
      if (appsError) {
        return (
          <>
            <PageHeader>{backLink}</PageHeader>
            {loadError}
          </>
        );
      }
      return (
        <>
          <PageHeader>{backLink}</PageHeader>
          <div className="flex flex-col gap-6" aria-busy>
            <div className="flex items-start gap-4">
              <Skeleton className="size-14 rounded-16 sm:size-16" />
              <div className="min-w-0 flex-1 space-y-2 pt-1">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-full max-w-3xl" />
              </div>
            </div>
            <div className="@container">
              <div className={BODY_GRID}>
                <Skeleton className="h-64 w-full rounded-12 @4xl:col-start-2 @4xl:row-start-1" />
                <Skeleton className="h-64 w-full rounded-12 @4xl:col-start-1 @4xl:row-start-1" />
              </div>
            </div>
          </div>
        </>
      );
    }
    if (!app) {
      return (
        <>
          <PageHeader>{backLink}</PageHeader>
          {loadError}
          <p className="text-ui text-subtle-foreground">{t("detail.notFound")}</p>
        </>
      );
    }

    // Kinds the app declares lead; the empty ones collapse to their heading
    // row below them, so the inventory reads as what the app does.
    const capabilityOrder = [
      ...CAPABILITY_KEYS.filter((key) => app.capabilityDetails[key].length > 0),
      ...CAPABILITY_KEYS.filter((key) => app.capabilityDetails[key].length === 0),
    ];

    return (
      <>
        <PageHeader className="gap-x-6 gap-y-5">
          {backLink}
          <div className="flex min-w-0 flex-1 basis-96 flex-col items-start gap-4 sm:flex-row">
            <TileIcon
              kind="image"
              size="lg"
              displayName={app.displayName}
              iconUrl={app.iconUrl}
              muted={app.status === "disabled"}
            />
            <PageHeading className="min-w-0 flex-1 gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <PageTitle>{app.displayName}</PageTitle>
                <Badge variant={STATUS_BADGE[app.status]}>
                  <span
                    className={cn("inline-block size-1.5 rounded-full", getStatusDot(app.status))}
                    aria-hidden
                  />
                  {t(`status.${app.status}`)}
                </Badge>
              </div>
              <p className="text-aux text-subtle-foreground">
                {app.id} &middot; v{app.version}
              </p>
              {app.description ? (
                <PageDescription className="mt-1 max-w-3xl text-pretty">
                  {app.description}
                </PageDescription>
              ) : null}
            </PageHeading>
          </div>
          {renderHeaderActions(app)}
        </PageHeader>

        {loadError}

        {app.error ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertDescription>{app.error}</AlertDescription>
          </Alert>
        ) : null}

        {candidate ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-12 border border-success-border bg-success-bg px-4 py-3">
            <p className="text-ui text-success-fg">
              {t("detail.updateBanner", { version: candidate.availableVersion })}
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

        <div className="@container">
          <div className={BODY_GRID}>
            {/* First in source so a narrow page reaches the controls before
                the inventory; the grid moves it to the rail when there is room. */}
            <div className="min-w-0 @4xl:col-start-2 @4xl:row-start-1">
              {renderManageSection(app)}
            </div>
            <div className="flex min-w-0 flex-col gap-4 @4xl:col-start-1 @4xl:row-start-1">
              {capabilityOrder.map((key) => renderCapability(app, key))}
              {readme ? (
                <Panel title={t("detail.readme")}>
                  <div className="px-5 py-5 sm:px-6">
                    <Markdown className="max-w-3xl text-foreground">{readme}</Markdown>
                  </div>
                </Panel>
              ) : null}
            </div>
          </div>
        </div>
      </>
    );
  };

  return (
    <Page>
      {renderBody()}

      {lifecycle.dialogs}
      <AppRemixDialog app={remixOpen ? app : null} onClose={() => setRemixOpen(false)} />
    </Page>
  );
}
