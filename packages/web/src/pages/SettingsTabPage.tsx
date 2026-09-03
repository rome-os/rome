import { useState, useEffect, useCallback, useId, useRef, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  FavorActionAuthorization,
  FavorActionRequestSyncPage,
  FavorActionRequestView,
  FavorBalanceView,
  FavorLedgerKind,
  FavorLedgerPage,
  FavorRechargeCheckout,
  FavorRechargePackList,
  FavorRechargePackView,
} from "@rome/api-types/favors";
import { isElectronShell } from "@/lib/electron-shell";
import { artifactLocalName } from "@/lib/artifact-name";
import { getApiErrorMessage } from "@/lib/api-error";
import { fetchJson } from "@/lib/fetch-json";
import { setPresentationMode, usePresentationMode } from "@/lib/presentation-mode";
import { relativeTime } from "@/lib/routine-language";
import { cn } from "@/lib/utils";
import {
  Check,
  Coins,
  Copy,
  CreditCard,
  History,
  Languages,
  Mail,
  Monitor,
  Moon,
  Info,
  Palette,
  RefreshCw,
  Sun,
  WalletCards,
  X,
} from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ADVANCED_EASTER_EGG_ART,
  ADVANCED_EASTER_EGG_INITIAL_SEQUENCE,
  advanceAdvancedEasterEggSequence,
} from "@/lib/advanced-easter-egg";
import { ConnectionsSection } from "@/components/ConnectionsSection";
import { ChannelsSettingsPage } from "@/components/channels/channels-settings-page";
import { AiToolsPanel } from "@/components/ai-tools-panel";
import { SystemUpgradeSection } from "@/components/system-upgrade-section";
import { SystemDiagnosisSection } from "@/components/system-diagnosis-section";
import { useTailscaleConnect } from "@/hooks/use-tailscale-connect";
import { useInvalidateSettings } from "@/hooks/use-settings";
import { useTheme } from "@/hooks/use-theme";
import { parseEmailTextarea } from "@/lib/email-list";
import { StatusIndicator } from "@/lib/connection-status";
import type { ThemePreference } from "@/lib/theme";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";
import {
  accessControlChecksPassed,
  describeTailscaleCertError,
  probeTailnetReachable,
  requestSessionHandoff,
  submitSessionHandoff,
  type SessionHandoffPayload,
} from "@/lib/access-control-client";
import type { ComposioCliStatus } from "@/lib/provider-types";
import { PageShell, PageBody } from "@/shell/PageShell";
import {
  CONNECTIONS_REFRESH_INTERVAL_MS,
  fetchConnections,
  type ApiConnection,
} from "@/lib/connections-api";

// ── Types ──────────────────────────────────────────────

interface SettingsData {
  enableModelSelector?: boolean;
  enableFable?: boolean;
  enableImpersonation?: boolean;
  showAiToolUsage?: boolean;
}

interface TailscaleDevice {
  id: string;
  hostname: string;
  name: string;
  os: string;
  addresses: string[];
  clientVersion: string;
  lastSeen: string;
  online: boolean;
}

interface TailscalePeer {
  hostname: string;
  fqdn: string;
  ip: string;
  os: string;
  online: boolean;
  isSelf: boolean;
}

interface TailscaleState {
  mode: "daemon" | "oauth";
  // Daemon mode fields
  status?: string;
  ip?: string;
  hostname?: string;
  fqdn?: string;
  advertiseExitNode?: boolean;
  peers?: TailscalePeer[];
  // OAuth mode fields
  configured?: boolean;
  devices?: TailscaleDevice[];
}

// ── Tabs ───────────────────────────────────────────────

export const TABS = [
  "Appearance",
  "Connections",
  "Channels",
  "AI Tools",
  "Favors",
  "Advanced",
] as const;

type Tab = (typeof TABS)[number];

export const VISIBLE_TABS = TABS;

// Only these tabs read what `loadAll` fetches (/api/settings plus the tailscale
// device list). Connections, Channels and Favors own their requests, and
// Appearance reads the theme/i18n context, so neither the initial settings load
// nor a settings failure has anything to say about them — gating all six on one
// request would strand a guardian on a healthy tab.
const SETTINGS_BACKED_TABS: ReadonlySet<Tab> = new Set<Tab>(["AI Tools", "Advanced"]);

function tabToSlug(tab: Tab): string {
  return tab.toLowerCase().replace(/\s+/g, "-");
}

export function normalizeTab(value: string | null): Tab | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (normalized === "session" || normalized === "tailscale") {
    return "Advanced";
  }
  if (normalized === "integrations") {
    return "Connections";
  }
  const match = TABS.find((tab) => tab.toLowerCase().replace(/\s+/g, "-") === normalized);
  return match ?? null;
}

// Tabs whose controls were relocated to the Inbox page (/apps/inbox). Old
// bookmarks/links to these slugs redirect there instead of silently rendering
// an unrelated settings tab.
const TABS_MOVED_TO_INBOX = new Set(["trust", "sentinel", "sentinel-log"]);

function isMovedToInbox(value: string | null | undefined): boolean {
  if (!value) return false;
  return TABS_MOVED_TO_INBOX.has(
    value
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "-"),
  );
}

// ── Component ──────────────────────────────────────────

export default function SettingsPage() {
  const { t } = useTranslation("settings");
  const params = useParams<{ tab?: string }>();
  const redirectToInbox = isMovedToInbox(params.tab);
  const normalizedTab = normalizeTab(params.tab ?? null);
  const activeTab = normalizedTab ?? TABS[0];

  const invalidateSettings = useInvalidateSettings();
  const [settings, setSettings] = useState<SettingsData>({});
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [composio, setComposio] = useState<ComposioCliStatus | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleState>({
    mode: "oauth",
    configured: false,
    devices: [],
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Data loading ──

  // The Connections tab's single data source (`/api/connections`) plus the
  // Composio account status for the broker card.
  const loadConnections = useCallback(
    async (backgroundRefresh = false) => {
      if (!backgroundRefresh) {
        setConnectionsLoading(true);
        setConnectionsError(null);
      }
      try {
        const [connectionList, composioRes] = await Promise.all([
          fetchConnections(),
          fetch("/api/integrations/composio/status", { cache: "no-store" }),
        ]);
        setConnections(connectionList);
        if (composioRes.ok) {
          const payload = (await composioRes.json()) as {
            composio?: ComposioCliStatus;
          };
          setComposio(payload.composio ?? null);
        }
        setConnectionsError(null);
      } catch (err) {
        console.error("Failed to load connections data", err);
        setConnectionsError(
          err instanceof Error ? err.message : t("connections.loadFailedFallback"),
        );
      } finally {
        if (!backgroundRefresh) setConnectionsLoading(false);
      }
    },
    [t],
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [settingsResponse, tailscaleResponse] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/tailscale/devices"),
      ]);
      if (!settingsResponse.ok) {
        throw new Error(await getApiErrorMessage(settingsResponse, t("page.loadFailedFallback")));
      }
      setSettings(await settingsResponse.json());
      if (tailscaleResponse.ok) setTailscale(await tailscaleResponse.json());
    } catch (err) {
      console.error("Failed to load settings data", err);
      setLoadError(err instanceof Error ? err.message : t("page.loadFailedFallback"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (activeTab !== "Connections") return;
    void loadConnections();
    const interval = window.setInterval(
      () => void loadConnections(true),
      CONNECTIONS_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [activeTab, loadConnections]);

  // ── Helpers ──

  async function saveSettings(patch: Record<string, unknown>) {
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, t("page.saveFailedFallback")));
      }
      setSettings((prev) => ({ ...prev, ...patch }));
      invalidateSettings();
      toast.success(t("page.savedFlash"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("page.saveFailedFallback"), {
        action: {
          label: t("page.retry"),
          onClick: () => void saveSettings(patch),
        },
      });
    } finally {
      setSaving(false);
    }
  }

  // ── Render ──

  // Controls relocated to the Inbox page — send legacy /settings/{trust,sentinel,
  // sentinel-log} links there rather than rendering an unrelated tab.
  if (redirectToInbox) {
    return <Navigate to="/apps/inbox" replace />;
  }

  // Unknown settings slugs are not pages. Redirect them to the canonical
  // default instead of rendering Appearance under a stale URL.
  if (params.tab && !normalizedTab) {
    return <Navigate to="/settings/appearance" replace />;
  }

  // The frame, heading and nav render unconditionally: gating them on `loading`
  // reintroduced the whole-page swap this page is supposed to have stopped, and
  // it hid the nav during the wait so no other tab was reachable.
  const tabNeedsSettings = SETTINGS_BACKED_TABS.has(activeTab);

  return (
    <PageShell>
      <PageBody>
        <h1 className="text-title text-foreground">{t("page.title")}</h1>

        {/* Navigation, not a tablist: each entry is a route change, and the
          section it reveals renders outside this element rather than in a
          `TabsContent`. Using `Tabs` here would emit `role="tab"` with
          `aria-controls` pointing at tabpanel ids that don't exist. Styled as
          the same underline bar; `aria-current="page"` marks the active route. */}
        <nav aria-label={t("page.title")}>
          <ul className="flex w-full justify-start gap-6 overflow-x-auto overflow-y-hidden border-b border-border">
            {VISIBLE_TABS.map((tab) => {
              const slug = tabToSlug(tab);
              const isActive = tab === activeTab;
              return (
                <li key={tab}>
                  <Link
                    to={`/settings/${slug}`}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "relative inline-flex items-center whitespace-nowrap px-2 py-1 text-ui transition-colors",
                      // A 2px border on a zero-content pseudo-element, not a
                      // sized box, so it authors no off-scale edge length.
                      "after:absolute after:inset-x-0 after:bottom-[-1px] after:border-b-2 after:border-foreground after:opacity-0 after:transition-opacity",
                      isActive
                        ? "text-foreground after:opacity-100"
                        : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
                    )}
                  >
                    {t(`tabs.${tab}` as const)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Tab content. Settings rows are label/control pairs, so this column
          keeps a reading measure while the frame above stays full-bleed — the
          h1 and the nav land at the same x as on every other route, and only
          the form narrows. Loading and failure swap this column only, and only
          for the tabs that read the settings payload, so a dead /api/settings
          still leaves Connections, Channels, Favors and Appearance usable. */}
        <div className="max-w-3xl">
          {tabNeedsSettings && loading ? (
            <p className="text-ui text-muted-foreground">{t("page.loading")}</p>
          ) : tabNeedsSettings && loadError ? (
            <Card>
              <CardContent className="flex flex-col items-start gap-3">
                <p className="text-ui text-destructive">{loadError}</p>
                <Button type="button" size="sm" onClick={() => void loadAll()}>
                  <RefreshCw />
                  {t("page.retry")}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              {activeTab === "Appearance" && <AppearanceSection />}
              {activeTab === "Connections" && (
                <ConnectionsSection
                  connections={connections}
                  composio={composio}
                  loading={connectionsLoading}
                  error={connectionsError}
                  onRetry={loadConnections}
                  onRefresh={loadConnections}
                  onFlash={(message) => toast.error(message)}
                />
              )}
              {activeTab === "Channels" && <ChannelsSettingsPage />}
              {activeTab === "Favors" && <FavorsSection />}
              {activeTab === "AI Tools" && (
                <AiToolsPanel showUsage={settings.showAiToolUsage ?? false} />
              )}
              {activeTab === "Advanced" && (
                <AdvancedSection
                  settings={settings}
                  onSave={saveSettings}
                  saving={saving}
                  tailscale={tailscale}
                  onRefresh={loadAll}
                />
              )}
            </>
          )}
        </div>
      </PageBody>
    </PageShell>
  );
}

function AppearanceRow({
  icon,
  title,
  control,
}: {
  icon: ReactNode;
  title: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-8 bg-surface-muted text-muted-foreground [&_svg]:size-4.5">
        {icon}
      </div>
      <p className="min-w-0 flex-1 text-ui text-foreground">{title}</p>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function AppearanceSection() {
  const { t, i18n } = useTranslation("settings");
  const { theme, setTheme, themes, preference, setPreference } = useTheme();

  const currentLang: SupportedLanguage = (SUPPORTED_LANGUAGES as readonly string[]).includes(
    i18n.resolvedLanguage ?? "",
  )
    ? (i18n.resolvedLanguage as SupportedLanguage)
    : "en";

  const modeIcon =
    preference === "dark" ? <Moon /> : preference === "light" ? <Sun /> : <Monitor />;

  return (
    <div className="space-y-6">
      <div className="divide-y divide-border overflow-hidden rounded-8 border border-border bg-surface">
        <AppearanceRow
          icon={<Languages />}
          title={t("appearance.language.title")}
          control={
            <Select
              value={currentLang}
              onValueChange={(next) => {
                void i18n.changeLanguage(next);
              }}
            >
              <SelectTrigger className="w-44" aria-label={t("appearance.language.title")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <SelectItem key={lang} value={lang}>
                    {LANGUAGE_LABELS[lang]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <AppearanceRow
          icon={<Palette />}
          title={t("appearance.theme.title")}
          control={
            <Select value={theme} onValueChange={(next) => setTheme(next)}>
              <SelectTrigger className="w-44" aria-label={t("appearance.theme.title")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {themes.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <AppearanceRow
          icon={modeIcon}
          title={t("appearance.mode.title")}
          control={
            <Select
              value={preference}
              onValueChange={(next) => setPreference(next as ThemePreference)}
            >
              <SelectTrigger className="w-44" aria-label={t("appearance.mode.title")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value="system">
                  <Monitor />
                  {t("appearance.mode.system")}
                </SelectItem>
                <SelectItem value="light">
                  <Sun />
                  {t("appearance.mode.light")}
                </SelectItem>
                <SelectItem value="dark">
                  <Moon />
                  {t("appearance.mode.dark")}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </div>
    </div>
  );
}

function favorDisplayTitle(request: FavorActionRequestView): string {
  const title = request.displayPayload.title;
  return typeof title === "string" && title.trim() ? title : artifactLocalName(request.actionName);
}

function favorDisplaySummary(request: FavorActionRequestView): string | null {
  const summary = request.displayPayload.summary;
  return typeof summary === "string" && summary.trim() ? summary : null;
}

function favorDisplayFields(
  request: FavorActionRequestView,
): Array<{ label: string; value: string }> {
  const fields = request.displayPayload.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((field) => {
    if (!field || typeof field !== "object") return [];
    const record = field as Record<string, unknown>;
    if (typeof record.label !== "string") return [];
    const value = record.value;
    return [{ label: record.label, value: value == null ? "" : String(value) }];
  });
}

function favorDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function favorRequestStatusLabel(request: FavorActionRequestView): string {
  if (request.status === "settled") {
    if (request.dispatchStatus === "succeeded") return "Completed";
    if (request.dispatchStatus === "action_failed") return "Action failed";
    if (request.dispatchStatus === "claimed") return "Running";
    return "Queued";
  }
  if (request.status === "pending") return "Pending payment";
  return request.status.charAt(0).toUpperCase() + request.status.slice(1);
}

function favorLedgerKindLabel(kind: FavorLedgerKind): string {
  return kind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function FavorRequestRow({
  request,
  canDecide,
  busy,
  onPay,
  onDecline,
}: {
  request: FavorActionRequestView;
  canDecide: boolean;
  busy: string | null;
  onPay: (request: FavorActionRequestView) => void;
  onDecline: (request: FavorActionRequestView) => void;
}) {
  const { t } = useTranslation("settings");
  const fields = favorDisplayFields(request);
  const summary = favorDisplaySummary(request);
  const payBusy = busy === `pay:${request.id}`;
  const declineBusy = busy === `decline:${request.id}`;

  return (
    <div className="border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui text-foreground">{favorDisplayTitle(request)}</h3>
            <span className="rounded-8 bg-surface-muted px-2 py-1 text-badge text-muted-foreground">
              {favorRequestStatusLabel(request)}
            </span>
          </div>
          {summary && <p className="mt-1 text-body text-muted-foreground">{summary}</p>}
          {fields.length > 0 && (
            <dl className="mt-3 grid gap-2 text-ui sm:grid-cols-2">
              {fields.map((field) => (
                <div key={`${request.id}:${field.label}`} className="min-w-0">
                  <dt className="text-aux uppercase text-muted-foreground">{field.label}</dt>
                  <dd className="truncate text-foreground" title={field.value}>
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-3 text-aux text-muted-foreground">
            {request.requesterAppId} · {favorDate(request.updatedAt)}
          </p>
          {request.failureReason && (
            <p className="mt-2 text-ui text-destructive">{request.failureReason}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-ui text-foreground">{request.amount} favors</span>
          {canDecide && (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => onPay(request)}
                disabled={busy !== null}
                aria-label={payBusy ? t("favors.payingApprovalRequest") : undefined}
              >
                {payBusy ? (
                  <Spinner size="sm" label={t("favors.payingApprovalRequest")} />
                ) : (
                  <Check />
                )}
                Pay
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onDecline(request)}
                disabled={busy !== null}
                aria-label={declineBusy ? t("favors.decliningApprovalRequest") : undefined}
              >
                {declineBusy ? (
                  <Spinner size="sm" label={t("favors.decliningApprovalRequest")} />
                ) : (
                  <X />
                )}
                Decline
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FavorsSection() {
  const { t } = useTranslation("settings");
  const query = useQuery({
    queryKey: ["settings", "favors"],
    queryFn: async () => {
      const [balance, actionRequests, ledger, recharge] = await Promise.all([
        fetchJson<FavorBalanceView>("/api/favors/balance", {
          fallback: "Failed to load favor balance.",
        }),
        fetchJson<FavorActionRequestSyncPage>("/api/favors/action-requests", {
          fallback: "Failed to load favor requests.",
        }),
        fetchJson<FavorLedgerPage>("/api/favors/ledger", {
          fallback: "Failed to load favor ledger.",
        }),
        fetchJson<FavorRechargePackList>("/api/favors/recharge", {
          fallback: "Failed to load favor recharge packs.",
        }),
      ]);
      return {
        balance,
        requests: actionRequests.requests ?? [],
        ledger: ledger.entries ?? [],
        packs: recharge.packs ?? [],
      };
    },
  });
  const [busyRequest, setBusyRequest] = useState<string | null>(null);
  const [busyPack, setBusyPack] = useState<string | null>(null);

  async function resolveRequest(request: FavorActionRequestView, decision: "pay" | "decline") {
    setBusyRequest(`${decision}:${request.id}`);
    try {
      const result = await fetchJson<FavorActionAuthorization>(
        `/api/favors/action-requests/${request.id}/${decision}`,
        {
          method: "POST",
          fallback: `Failed to ${decision} favor request.`,
        },
      );
      if (result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      toast.success(decision === "pay" ? "Favor request paid" : "Favor request declined");
      await query.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${decision} favor request.`);
    } finally {
      setBusyRequest(null);
    }
  }

  async function startRecharge(pack: FavorRechargePackView) {
    setBusyPack(pack.id);
    try {
      const result = await fetchJson<FavorRechargeCheckout>("/api/favors/recharge", {
        method: "POST",
        json: { packId: pack.id },
        fallback: "Failed to start favor recharge.",
      });
      window.location.assign(result.url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start favor recharge.");
      setBusyPack(null);
    }
  }

  if (query.isLoading) {
    return <p className="text-ui text-muted-foreground">Loading favors...</p>;
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <CardContent>
          <p className="text-ui text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load favors."}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void query.refetch()}
          >
            <RefreshCw />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { balance, requests, ledger, packs } = query.data;
  const pending = requests.filter(
    (request) => request.status === "pending" && request.payerUserId === balance.userId,
  );
  const failed = requests.filter(
    (request) =>
      request.dispatchStatus === "action_failed" && request.requestorUserId === balance.userId,
  );
  const history = requests.filter((request) => request.status !== "pending");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-section text-foreground">Favors</h2>
        <p className="mt-1 text-body text-muted-foreground">
          Balance, payments, and paid app actions settled through Rome Cloud.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent>
            <div className="flex items-center gap-2 text-ui text-muted-foreground">
              <WalletCards className="size-4" />
              Balance
            </div>
            <p className="mt-2 text-title tabular-nums text-foreground">{balance.available}</p>
            <p className="mt-1 text-aux text-muted-foreground">available favors</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="flex items-center gap-2 text-ui text-muted-foreground">
              <Coins className="size-4" />
              Earned
            </div>
            <p className="mt-2 text-title tabular-nums text-foreground">{balance.lifetimeEarned}</p>
            <p className="mt-1 text-aux text-muted-foreground">lifetime favors</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="flex items-center gap-2 text-ui text-muted-foreground">
              <History className="size-4" />
              Spent
            </div>
            <p className="mt-2 text-title tabular-nums text-foreground">{balance.lifetimeSpent}</p>
            <p className="mt-1 text-aux text-muted-foreground">lifetime favors</p>
          </CardContent>
        </Card>
      </div>

      <section className="rounded-8 border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h3 className="text-section text-foreground">Recharge</h3>
          <CreditCard className="size-4 text-muted-foreground" />
        </div>
        {packs.length === 0 ? (
          <p className="px-4 py-4 text-ui text-muted-foreground">No recharge packs configured.</p>
        ) : (
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            {packs.map((pack) => (
              <Button
                key={pack.id}
                type="button"
                variant="outline"
                className="justify-between"
                onClick={() => void startRecharge(pack)}
                disabled={busyPack !== null}
                aria-label={busyPack === pack.id ? t("favors.startingPackPurchase") : undefined}
              >
                <span>{pack.favors.toLocaleString()} favors</span>
                {pack.displayPrice ? (
                  <span className="ml-auto text-aux text-muted-foreground">
                    {pack.displayPrice}
                  </span>
                ) : null}
                {busyPack === pack.id ? (
                  <Spinner label={t("favors.startingPackPurchase")} />
                ) : (
                  <CreditCard />
                )}
              </Button>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-8 border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-section text-foreground">Awaiting your payment decision</h3>
        </div>
        {pending.length === 0 ? (
          <p className="px-4 py-4 text-ui text-muted-foreground">No pending favor requests.</p>
        ) : (
          pending.map((request) => (
            <FavorRequestRow
              key={request.id}
              request={request}
              canDecide
              busy={busyRequest}
              onPay={(next) => void resolveRequest(next, "pay")}
              onDecline={(next) => void resolveRequest(next, "decline")}
            />
          ))
        )}
      </section>

      {failed.length > 0 && (
        <section className="rounded-8 border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-section text-foreground">Failed owner-side actions</h3>
          </div>
          {failed.map((request) => (
            <FavorRequestRow
              key={request.id}
              request={request}
              canDecide={false}
              busy={busyRequest}
              onPay={(next) => void resolveRequest(next, "pay")}
              onDecline={(next) => void resolveRequest(next, "decline")}
            />
          ))}
        </section>
      )}

      <section className="rounded-8 border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-section text-foreground">Paid action requests</h3>
        </div>
        {history.length === 0 ? (
          <p className="px-4 py-4 text-ui text-muted-foreground">No paid action requests yet.</p>
        ) : (
          history.map((request) => (
            <FavorRequestRow
              key={request.id}
              request={request}
              canDecide={false}
              busy={busyRequest}
              onPay={(next) => void resolveRequest(next, "pay")}
              onDecline={(next) => void resolveRequest(next, "decline")}
            />
          ))
        )}
      </section>

      <section className="rounded-8 border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-section text-foreground">Ledger</h3>
        </div>
        {ledger.length === 0 ? (
          <p className="px-4 py-4 text-ui text-muted-foreground">No ledger entries yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {ledger.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-ui text-foreground">
                    {favorLedgerKindLabel(entry.kind)}
                  </p>
                  <p className="text-aux text-muted-foreground">{favorDate(entry.createdAt)}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-ui",
                    entry.amount >= 0 ? "text-success-fg" : "text-foreground",
                  )}
                >
                  {entry.amount >= 0 ? "+" : ""}
                  {entry.amount}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function AdvancedSection({
  settings,
  onSave,
  saving,
  tailscale,
  onRefresh,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
  tailscale: TailscaleState;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [showEasterEgg, setShowEasterEgg] = useState(false);
  const sequenceRef = useRef(ADVANCED_EASTER_EGG_INITIAL_SEQUENCE);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const result = advanceAdvancedEasterEggSequence(sequenceRef.current, event);
      sequenceRef.current = result.state;
      if (result.unlocked) {
        setShowEasterEgg(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return (
    <div className="space-y-8">
      <h2 className="text-section text-foreground">{t("advanced.title")}</h2>
      {/* Not rendered in the Mac app. Its check and upgrade actions relay to
          Rome Cloud, which resolves them against the account's *hosted*
          instance — a machine other than the one showing the page. The version
          card above them is read from the local build and is correct on
          desktop, but it is not worth splitting the section to keep: the Mac
          app has its own version surface, and a panel whose only button acts
          on somewhere else is worse than an absent one.

          This is a mitigation. It keys on which window is rendering, not on
          what kind of backend is behind the page, so the same dashboard opened
          in a browser at the loopback port still shows it. */}
      {!isElectronShell() && (
        <div className="border-b border-border pb-8">
          <SystemUpgradeSection />
        </div>
      )}
      <div className="border-b border-border pb-8">
        <AccessControlSection tailscale={tailscale} onRefresh={onRefresh} />
      </div>
      <div className="border-b border-border pb-8">
        <SystemDiagnosisSection />
      </div>
      <div className="border-b border-border pb-8">
        <PresentationModeSection />
      </div>
      <DeveloperSettingsSection settings={settings} onSave={onSave} saving={saving} />
      {showEasterEgg && <AdvancedEasterEggOverlay onClose={() => setShowEasterEgg(false)} />}
    </div>
  );
}

/** Presentation mode is a per-browser rendering preference (localStorage via
 * `@/lib/presentation-mode`), not a guardian setting — deliberately no `onSave`,
 * nothing goes to `/api/settings`. It masks pinned-agent identity across chat
 * surfaces so screen recordings look like a normal conversation. */
function PresentationModeSection() {
  const { t } = useTranslation("settings");
  const enabled = usePresentationMode();

  return (
    <div>
      <h2 className="text-section text-foreground">{t("advanced.presentationMode.title")}</h2>
      <p className="mt-1 mb-4 text-body text-muted-foreground">
        {t("advanced.presentationMode.description")}
      </p>
      <ToggleSwitch
        checked={enabled}
        onChange={setPresentationMode}
        label={t("advanced.presentationMode.toggleLabel")}
      />
    </div>
  );
}

function DeveloperSettingsSection({
  settings,
  onSave,
  saving,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation("settings");
  // Mount the relay widget only while the section is expanded so its status
  // polling doesn't run for everyone who merely opens the Advanced tab.
  const [open, setOpen] = useState(false);

  return (
    <details className="group" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="list-none rounded-8 py-1 text-left [&::-webkit-details-marker]:hidden">
        <span className="block text-section text-foreground">
          {t("advanced.developerSettings.title")}
        </span>
      </summary>
      <div className="mt-6 space-y-8">
        <FableAdvancedSection settings={settings} onSave={onSave} saving={saving} />
        <ModelSelectorAdvancedSection settings={settings} onSave={onSave} saving={saving} />
        <ImpersonationAdvancedSection settings={settings} onSave={onSave} saving={saving} />
        <AiToolUsageAdvancedSection settings={settings} onSave={onSave} saving={saving} />
        {open && <RelayHealthSection />}
      </div>
    </details>
  );
}

function FableAdvancedSection({
  settings,
  onSave,
  saving,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState(settings.enableFable ?? false);

  function toggle(next: boolean) {
    setEnabled(next);
    void onSave({ enableFable: next });
  }

  return (
    <div>
      <h3 className="mb-2 text-ui text-foreground">{t("advanced.fable.title")}</h3>
      <p className="mb-4 text-aux text-muted-foreground">{t("advanced.fable.description")}</p>
      <ToggleSwitch
        checked={enabled}
        onChange={toggle}
        disabled={saving}
        label={t("advanced.fable.toggleLabel")}
      />
    </div>
  );
}

// ── Relay health (Developer Settings) ──────────────────

/** Mirrors RelayStatus from @rome/core (packages/core/src/relay/settings.ts). */
interface RelayHealth {
  configured: boolean;
  drainUrl: string | null;
  depositUrl: string | null;
  targetApp: string | null;
  backlog: number | null;
  state: "connected" | "notConnected" | "reconnecting" | "retrying" | "blocked";
  nextAttemptAt: number | null;
  failure: {
    seq: number | null;
    status: number | null;
    error: string | null;
  } | null;
}

function RelayHealthSection() {
  const { t } = useTranslation("settings");
  const [resuming, setResuming] = useState(false);
  const query = useQuery({
    queryKey: ["integrations", "relay"] as const,
    refetchInterval: 5_000,
    queryFn: ({ signal }) =>
      fetchJson<{ relay: RelayHealth | null }>("/api/integrations/relay", {
        signal,
        fallback: t("advanced.relayHealth.loadFailed"),
      }),
  });
  const relay = query.data?.relay ?? null;

  async function resumeDelivery() {
    setResuming(true);
    try {
      const result = await fetchJson<{ resumed: boolean }>("/api/integrations/relay/resume", {
        method: "POST",
        fallback: t("advanced.relayHealth.resumeFailed"),
      });
      if (result.resumed) toast.success(t("advanced.relayHealth.resumed"));
      await query.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("advanced.relayHealth.resumeFailed"));
    } finally {
      setResuming(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <h3 className="text-ui text-foreground">{t("advanced.relayHealth.title")}</h3>
        {relay && (
          <StatusIndicator
            status={
              !relay.configured
                ? {
                    label: t("advanced.relayHealth.status.notConfigured"),
                    tone: "muted",
                  }
                : relay.state === "blocked"
                  ? {
                      label: t("advanced.relayHealth.status.blocked"),
                      tone: "attention",
                    }
                  : relay.state === "retrying"
                    ? {
                        label: t("advanced.relayHealth.status.retrying"),
                        tone: "attention",
                      }
                    : relay.state === "reconnecting"
                      ? {
                          label: t("advanced.relayHealth.status.reconnecting"),
                          tone: "attention",
                        }
                      : relay.state === "connected"
                        ? {
                            label: t("advanced.relayHealth.status.connected"),
                            tone: "success",
                          }
                        : {
                            label: t("advanced.relayHealth.status.notConnected"),
                            tone: "attention",
                          }
            }
          />
        )}
        {relay?.state === "blocked" && (
          <Button
            size="xs"
            variant="outline"
            disabled={resuming}
            onClick={() => void resumeDelivery()}
          >
            {resuming ? t("advanced.relayHealth.resuming") : t("advanced.relayHealth.resume")}
          </Button>
        )}
      </div>
      {query.isLoading ? (
        <p className="text-ui text-muted-foreground">{t("advanced.relayHealth.loading")}</p>
      ) : query.error ? (
        <p className="text-ui text-destructive-fg">
          {query.error instanceof Error
            ? query.error.message
            : t("advanced.relayHealth.loadFailed")}
        </p>
      ) : !relay?.configured ? (
        <p className="text-ui text-muted-foreground">
          {t("advanced.relayHealth.notConfiguredHint")}
        </p>
      ) : (
        <Card>
          <CardContent>
            <dl className="space-y-3 text-ui">
              <RelayHealthRow label={t("advanced.relayHealth.depositUrl")}>
                {relay.depositUrl ? (
                  <span className="flex items-center gap-1">
                    <span className="break-all font-mono text-aux">{relay.depositUrl}</span>
                    <CopyValueButton value={relay.depositUrl} />
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </RelayHealthRow>
              <RelayHealthRow label={t("advanced.relayHealth.drainUrl")}>
                <span className="break-all font-mono text-aux">{relay.drainUrl ?? "—"}</span>
              </RelayHealthRow>
              <RelayHealthRow label={t("advanced.relayHealth.targetApp")}>
                {relay.targetApp ?? (
                  <span className="text-warning-fg">{t("advanced.relayHealth.noConsumer")}</span>
                )}
              </RelayHealthRow>
              <RelayHealthRow label={t("advanced.relayHealth.backlog")}>
                {relay.backlog ?? <span className="text-muted-foreground">—</span>}
              </RelayHealthRow>
              {relay.nextAttemptAt != null && (
                <RelayHealthRow label={t("advanced.relayHealth.nextAttempt")}>
                  {relativeTime(new Date(relay.nextAttemptAt).toISOString())}
                </RelayHealthRow>
              )}
              {relay.failure && (
                <RelayHealthRow label={t("advanced.relayHealth.failure")}>
                  <span className="break-all text-destructive-fg">
                    {formatRelayFailure(relay.failure)}
                  </span>
                </RelayHealthRow>
              )}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function formatRelayFailure(failure: NonNullable<RelayHealth["failure"]>) {
  const outcome =
    failure.status != null ? `HTTP ${failure.status}` : failure.error || "Unknown error";
  return failure.seq != null ? `Event #${failure.seq}: ${outcome}` : outcome;
}

function RelayHealthRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground">{children}</dd>
    </div>
  );
}

function CopyValueButton({ value }: { value: string }) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard unavailable (e.g. non-secure context); the value is selectable text.
    }
  }

  return (
    <IconButton
      size="sm"
      label={copied ? t("advanced.relayHealth.copied") : t("advanced.relayHealth.copy")}
      icon={copied ? <Check className="text-success-fg" /> : <Copy />}
      onClick={() => void copy()}
    />
  );
}

type ToggleSwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
} & ({ label: string; ariaLabel?: string } | { label?: undefined; ariaLabel: string });

function ToggleSwitch({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
}: ToggleSwitchProps) {
  if (!label) {
    return (
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
      />
    );
  }

  return (
    <FieldLabel
      className={cn(
        "flex items-center gap-3 text-left",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
      {label}
    </FieldLabel>
  );
}

function ModelSelectorAdvancedSection({
  settings,
  onSave,
  saving,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState(settings.enableModelSelector ?? false);

  function toggle(next: boolean) {
    setEnabled(next);
    void onSave({ enableModelSelector: next });
  }

  return (
    <div>
      <h3 className="mb-4 text-ui text-foreground">{t("advanced.modelSelector.title")}</h3>
      <ToggleSwitch
        checked={enabled}
        onChange={toggle}
        disabled={saving}
        label={t("advanced.modelSelector.toggleLabel")}
      />
    </div>
  );
}

function ImpersonationAdvancedSection({
  settings,
  onSave,
  saving,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState(settings.enableImpersonation ?? false);

  function toggle(next: boolean) {
    setEnabled(next);
    void onSave({ enableImpersonation: next });
  }

  return (
    <div>
      <h3 className="mb-4 text-ui text-foreground">{t("advanced.impersonation.title")}</h3>
      <ToggleSwitch
        checked={enabled}
        onChange={toggle}
        disabled={saving}
        label={t("advanced.impersonation.toggleLabel")}
      />
    </div>
  );
}

function AiToolUsageAdvancedSection({
  settings,
  onSave,
  saving,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState(settings.showAiToolUsage ?? false);

  function toggle(next: boolean) {
    setEnabled(next);
    void onSave({ showAiToolUsage: next });
  }

  return (
    <div>
      <h3 className="mb-2 text-ui text-foreground">{t("advanced.aiToolUsage.title")}</h3>
      <p className="mb-4 text-aux text-muted-foreground">{t("advanced.aiToolUsage.description")}</p>
      <ToggleSwitch
        checked={enabled}
        onChange={toggle}
        disabled={saving}
        label={t("advanced.aiToolUsage.toggleLabel")}
      />
    </div>
  );
}

function AdvancedEasterEggOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settings");
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-hidden px-4 py-8">
      <div
        className="rome-advanced-easter-egg-backdrop pointer-events-auto absolute inset-0 bg-foreground/55 backdrop-blur-md"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Decorative easter-egg art: a fixed-dark set piece with a deliberately
          theatrical cast, kept off the elevation scale on purpose. */}
      <div className="rome-advanced-easter-egg pointer-events-auto relative w-full max-w-[min(94vw,1040px)] overflow-hidden rounded-16 border border-surface/[0.08] bg-gradient-to-b from-zinc-900 via-zinc-950 to-black shadow-[0_30px_120px_-20px_rgba(0,0,0,0.85)]">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-200/50 to-transparent" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: "radial-gradient(rgba(255,255,255,0.7) 1px, transparent 1px)",
            backgroundSize: "3px 3px",
          }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 80% at 50% 0%, rgba(252,211,77,0.06), transparent 60%)",
          }}
          aria-hidden="true"
        />

        <div className="relative flex items-center justify-between border-b border-surface/[0.06] px-6 py-3">
          <div className="flex items-center gap-3">
            <span
              className="rome-advanced-easter-egg-dot inline-block h-1.5 w-1.5 rounded-full bg-warning-bg"
              aria-hidden="true"
            />
            <span className="font-mono text-aux text-subtle-foreground">
              Rome
              <span className="mx-2 text-muted-foreground">/</span>
              <span className="text-subtle-foreground">{t("easterEgg.console")}</span>
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("easterEgg.closeLabel")}
            className="rounded-full border border-surface/10 text-subtle-foreground hover:border-surface/30 hover:bg-surface/5"
          >
            <X aria-hidden />
          </Button>
        </div>

        <div className="relative px-6 py-12 sm:py-16">
          {/* The glyph size defines this ASCII artwork, so no typography role can preserve it. */}
          <pre
            aria-label={t("easterEgg.artLabel")}
            className="rome-advanced-easter-egg-art mx-auto max-h-[60vh] overflow-auto whitespace-pre text-center font-mono text-[10px] drop-shadow-[0_1px_0_rgba(0,0,0,0.6)]"
          >
            {ADVANCED_EASTER_EGG_ART}
          </pre>
        </div>

        <div className="relative flex items-center justify-between border-t border-surface/[0.06] px-6 py-3 font-mono text-aux text-muted-foreground">
          <span>{t("easterEgg.estLine")}</span>
          <span className="hidden text-muted-foreground sm:inline">{t("easterEgg.tagline")}</span>
        </div>
      </div>
    </div>
  );
}

// ── Section: Tailscale ─────────────────────────────────

// ── Section: Access Control ───────────────────────────
// One first-level section with two subsections: who can sign in from the
// public host (allowed Rome Cloud emails), then the Tailscale network with
// its restrict-to-tailnet toggle.

function AccessControlSection({
  tailscale,
  onRefresh,
}: {
  tailscale: TailscaleState;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  return (
    <div>
      <h2 className="text-section text-foreground">{t("publicAccess.title")}</h2>
      <p className="mt-1 text-body text-muted-foreground">{t("publicAccess.description")}</p>
      <div className="mt-6 space-y-6">
        <AllowedCloudEmailsSection />
        <Card>
          <CardContent>
            <TailscaleSection tailscale={tailscale} onRefresh={onRefresh} />
            <TailnetRestrictionSection />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function TailscaleSection({
  tailscale,
  onRefresh,
}: {
  tailscale: TailscaleState;
  onRefresh: () => Promise<void>;
}) {
  if (tailscale.mode === "daemon") {
    return <TailscaleDaemonSection tailscale={tailscale} onRefresh={onRefresh} />;
  }
  return <TailscaleOAuthSection tailscale={tailscale} onRefresh={onRefresh} />;
}

// ── Daemon mode (Docker) ──────────────────────────────

function TailscaleDaemonSection({
  tailscale,
  onRefresh,
}: {
  tailscale: TailscaleState;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [savingExitNode, setSavingExitNode] = useState(false);
  const [exitNodeError, setExitNodeError] = useState<string | null>(null);

  const isConnected = tailscale.status === "connected";
  const exitNodeEnabled = tailscale.advertiseExitNode === true;
  const {
    connecting,
    authUrl,
    error,
    connect: handleConnect,
    clearAuthUrl,
  } = useTailscaleConnect(onRefresh);
  const isAuthenticating = tailscale.status === "authenticating" || !!authUrl;

  // Auto-poll while authenticating to detect when auth completes
  useEffect(() => {
    if (!isAuthenticating) return;
    const interval = setInterval(async () => {
      await onRefresh();
    }, 3000);
    return () => clearInterval(interval);
  }, [isAuthenticating, onRefresh]);

  // Clear authUrl when connected
  useEffect(() => {
    if (isConnected && authUrl) {
      clearAuthUrl();
    }
  }, [isConnected, authUrl, clearAuthUrl]);

  async function handleDisconnect() {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const res = await fetch("/api/tailscale/connect", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDisconnectError(data.error || t("common.connectionFailed"));
        return;
      }
      clearAuthUrl();
      await onRefresh();
    } catch {
      setDisconnectError(t("common.networkError"));
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleExitNodeToggle(nextEnabled: boolean) {
    setSavingExitNode(true);
    setExitNodeError(null);
    try {
      const res = await fetch("/api/tailscale/exit-node", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setExitNodeError(data.error || t("tailscale.exitNode.updateFailed"));
        return;
      }
      await onRefresh();
    } catch {
      setExitNodeError(t("tailscale.exitNode.updateFailed"));
    } finally {
      setSavingExitNode(false);
    }
  }

  const status = isConnected
    ? t("tailscale.status.connected")
    : isAuthenticating
      ? t("tailscale.status.authenticating")
      : t("tailscale.status.notConnected");

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-ui text-foreground">{t("tailscale.title")}</h3>
          <StatusIndicator
            status={{
              label: status,
              tone: isConnected ? "success" : isAuthenticating ? "attention" : "muted",
            }}
          />
          <span className="text-aux text-subtle-foreground">{t("tailscale.daemonMode")}</span>
        </div>
        {isConnected ? (
          <Button variant="destructive" onClick={handleDisconnect} disabled={disconnecting}>
            {disconnecting ? t("common.disconnecting") : t("common.disconnect")}
          </Button>
        ) : !isAuthenticating ? (
          <Button variant="outline" onClick={handleConnect} disabled={connecting}>
            {connecting ? t("common.connecting") : t("tailscale.connectButton")}
          </Button>
        ) : null}
      </div>

      {error && <p className="mb-4 text-ui text-destructive-fg">{error}</p>}
      {disconnectError && <p className="mb-4 text-ui text-destructive-fg">{disconnectError}</p>}
      {exitNodeError && <p className="mb-4 text-ui text-destructive-fg">{exitNodeError}</p>}

      {/* Authenticating state — show auth URL */}
      {isAuthenticating && authUrl && (
        <Alert variant="warning" className="mb-4 p-4">
          <Spinner label={t("tailscale.status.authenticating")} />
          <AlertTitle>{t("tailscale.authPrompt")}</AlertTitle>
          <AlertDescription className="min-w-0">
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate underline hover:no-underline"
            >
              {authUrl}
            </a>
            <p className="mt-2 text-aux">{t("tailscale.polling")}</p>
          </AlertDescription>
        </Alert>
      )}

      {/* Connected state — show info card + peers */}
      {isConnected && (
        <>
          <Alert variant="success" className="mb-4 p-4">
            <AlertDescription className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-aux">{t("tailscale.infoLabels.ip")}</p>
                <p className="font-mono text-ui text-foreground">{tailscale.ip || "—"}</p>
              </div>
              <div>
                <p className="text-aux">{t("tailscale.infoLabels.hostname")}</p>
                <p className="text-ui text-foreground">{tailscale.hostname || "—"}</p>
              </div>
              <div>
                <p className="text-aux">{t("tailscale.infoLabels.fqdn")}</p>
                <p className="font-mono text-ui text-foreground">{tailscale.fqdn || "—"}</p>
              </div>
            </AlertDescription>
          </Alert>

          {tailscale.peers && tailscale.peers.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("tailscale.peersTable.hostname")}</TableHead>
                  <TableHead>{t("tailscale.peersTable.fqdn")}</TableHead>
                  <TableHead>{t("tailscale.peersTable.ip")}</TableHead>
                  <TableHead>{t("tailscale.peersTable.os")}</TableHead>
                  <TableHead>{t("tailscale.peersTable.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tailscale.peers.map((peer) => (
                  <TableRow key={peer.fqdn}>
                    <TableCell>
                      <span className="text-foreground">{peer.hostname}</span>
                      {peer.isSelf && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-info-bg px-2 py-1 text-badge text-info-fg">
                          {t("tailscale.peersTable.thisDevice")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-aux text-muted-foreground">
                      {peer.fqdn}
                    </TableCell>
                    <TableCell className="font-mono text-aux text-muted-foreground">
                      {peer.ip}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{peer.os}</TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-badge ${
                          peer.online
                            ? "bg-success-bg text-success-fg"
                            : "bg-surface-muted text-muted-foreground"
                        }`}
                      >
                        {peer.online ? t("common.online") : t("common.offline")}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {tailscale.peers && tailscale.peers.length === 0 && (
            <p className="text-ui text-muted-foreground">{t("tailscale.noPeers")}</p>
          )}

          <Card className="mt-4">
            <CardHeader>
              {/* h4, not CardTitle's h3: this panel is nested inside the Tailscale
                  section, so it labels a control rather than heading a section.
                  "Exit node" is a term rather than a fact, so its meaning sits in
                  a tooltip and the row carries no description. */}
              <div className="flex items-center gap-2">
                <h4 className="text-ui text-foreground">{t("tailscale.exitNode.title")}</h4>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={t("tailscale.exitNode.termTooltip")}
                      >
                        <Info className="size-3.5" aria-hidden />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tailscale.exitNode.termTooltip")}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <CardAction>
                <ToggleSwitch
                  checked={exitNodeEnabled}
                  onChange={handleExitNodeToggle}
                  disabled={disconnecting || savingExitNode}
                  ariaLabel={t("tailscale.exitNode.title")}
                />
              </CardAction>
            </CardHeader>
            {savingExitNode && (
              <CardContent>
                <p className="text-aux text-subtle-foreground">
                  {t("tailscale.exitNode.updating")}
                </p>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── OAuth mode (host) ─────────────────────────────────

function TailscaleOAuthSection({
  tailscale,
  onRefresh,
}: {
  tailscale: TailscaleState;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [showModal, setShowModal] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  async function handleDisconnect() {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const res = await fetch("/api/tailscale/connect", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDisconnectError(data.error || t("common.connectionFailed"));
        return;
      }
      await onRefresh();
    } catch {
      setDisconnectError(t("common.networkError"));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-ui text-foreground">{t("tailscale.title")}</h3>
          <StatusIndicator
            status={
              tailscale.configured
                ? { label: t("tailscale.status.connected"), tone: "success" }
                : { label: t("tailscale.status.notConfigured"), tone: "muted" }
            }
          />
        </div>
        {tailscale.configured ? (
          <Button variant="destructive" onClick={handleDisconnect} disabled={disconnecting}>
            {disconnecting ? t("common.disconnecting") : t("common.disconnect")}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setShowModal(true)}>
            {t("tailscale.connectButtonOauth")}
          </Button>
        )}
      </div>

      {disconnectError && <p className="mb-4 text-ui text-destructive-fg">{disconnectError}</p>}

      {/* Desktop app download banner */}
      <Alert variant="info" className="mb-4">
        <AlertDescription>
          {t("tailscale.downloadBannerPrefix")}{" "}
          <a
            href="https://tailscale.com/download"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            {t("tailscale.downloadBannerLink")}
          </a>{" "}
          {t("tailscale.downloadBannerSuffix")}
        </AlertDescription>
      </Alert>

      {tailscale.configured && tailscale.devices && tailscale.devices.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("tailscale.devicesTable.name")}</TableHead>
              <TableHead>{t("tailscale.devicesTable.os")}</TableHead>
              <TableHead>{t("tailscale.devicesTable.ipAddresses")}</TableHead>
              <TableHead>{t("tailscale.devicesTable.version")}</TableHead>
              <TableHead>{t("tailscale.devicesTable.status")}</TableHead>
              <TableHead>{t("tailscale.devicesTable.lastSeen")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tailscale.devices.map((device) => (
              <TableRow key={device.id}>
                <TableCell>
                  <div className="text-ui text-foreground">{device.hostname}</div>
                  <div className="text-aux text-muted-foreground">{device.name}</div>
                </TableCell>
                <TableCell className="text-muted-foreground">{device.os}</TableCell>
                <TableCell>
                  <div className="space-y-1">
                    {device.addresses.map((addr) => (
                      <div key={addr} className="font-mono text-aux text-muted-foreground">
                        {addr}
                      </div>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-aux text-muted-foreground">
                  {device.clientVersion}
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-1 text-badge ${
                      device.online
                        ? "bg-success-bg text-success-fg"
                        : "bg-surface-muted text-muted-foreground"
                    }`}
                  >
                    {device.online ? t("common.online") : t("common.offline")}
                  </span>
                </TableCell>
                <TableCell className="text-aux text-muted-foreground">
                  {new Date(device.lastSeen).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {tailscale.configured && (!tailscale.devices || tailscale.devices.length === 0) && (
        <p className="text-ui text-muted-foreground">{t("tailscale.noDevices")}</p>
      )}

      {showModal && (
        <TailscaleConnectModal
          onClose={() => setShowModal(false)}
          onConnected={async () => {
            setShowModal(false);
            await onRefresh();
          }}
        />
      )}
    </div>
  );
}

function TailscaleConnectModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const uid = useId();
  const clientIdRef = useRef<HTMLInputElement | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/tailscale/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("common.connectionFailed"));
        return;
      }
      await onConnected();
    } catch {
      setError(t("common.networkError"));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <Dialog open onClose={onClose} size="sm" initialFocusRef={clientIdRef} className="p-6">
      <DialogTitle className="mb-4">{t("tailscale.modal.title")}</DialogTitle>
      <DialogDescription className="mb-4">
        {t("tailscale.modal.introPrefix")}{" "}
        <a
          href="https://login.tailscale.com/admin/settings/oauth"
          target="_blank"
          rel="noopener noreferrer"
          className="text-info-fg hover:underline"
        >
          {t("tailscale.modal.introLink")}
        </a>
        <Trans
          i18nKey="tailscale.modal.introSuffix"
          ns="settings"
          components={{ code: <code className="font-mono" /> }}
        />
      </DialogDescription>

      {error && <p className="mb-3 text-ui text-destructive-fg">{error}</p>}

      <div className="space-y-3">
        <Field>
          <FieldLabel htmlFor={`${uid}-tailscale-client-id`}>
            {t("tailscale.modal.clientIdLabel")}
          </FieldLabel>
          <Input
            ref={clientIdRef}
            id={`${uid}-tailscale-client-id`}
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={t("tailscale.modal.clientIdPlaceholder")}
            className="w-full"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-tailscale-client-secret`}>
            {t("tailscale.modal.clientSecretLabel")}
          </FieldLabel>
          <Input
            id={`${uid}-tailscale-client-secret`}
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={t("tailscale.modal.clientSecretPlaceholder")}
            className="w-full"
          />
        </Field>
      </div>

      <div className="mt-5 flex justify-end gap-3">
        <Button variant="outline" size="default" onClick={onClose}>
          {t("tailscale.modal.cancel")}
        </Button>
        <Button
          size="default"
          onClick={handleConnect}
          disabled={connecting || !clientId.trim() || !clientSecret.trim()}
        >
          {connecting ? t("common.connecting") : t("common.connect")}
        </Button>
      </div>
    </Dialog>
  );
}

interface PublicAccessConfig {
  enableAccessControl: boolean;
  allowedApps: string[];
  cloudEmailAccess: Record<string, string[]>;
}

interface DashboardAccessConfig {
  cloudEmailAccess: string[];
}

function normalizePublicAccessConfigPayload(raw: unknown): PublicAccessConfig {
  const body = (raw ?? {}) as Partial<PublicAccessConfig>;
  return {
    enableAccessControl: body.enableAccessControl === true,
    allowedApps: Array.isArray(body.allowedApps) ? body.allowedApps : [],
    cloudEmailAccess:
      body.cloudEmailAccess && typeof body.cloudEmailAccess === "object"
        ? body.cloudEmailAccess
        : {},
  };
}

function normalizeDashboardAccessConfigPayload(raw: unknown): DashboardAccessConfig {
  const body = (raw ?? {}) as Partial<DashboardAccessConfig>;
  return {
    cloudEmailAccess: Array.isArray(body.cloudEmailAccess) ? body.cloudEmailAccess : [],
  };
}

function AllowedCloudEmailsSection() {
  const { t } = useTranslation("settings");
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/dashboard-access")
      .then((response) => response.json())
      .catch(() => ({ cloudEmailAccess: [] }))
      .then((dashboardAccess) => {
        const normalized = normalizeDashboardAccessConfigPayload(dashboardAccess);
        setEmails(normalized.cloudEmailAccess);
      })
      .finally(() => setLoaded(true));
  }, []);

  // Saves `next` right away; on failure rolls the list back to `previous` so
  // the UI never shows a state the server rejected. Mutations are disabled
  // while a save is in flight, so `previous` is always the server's state.
  async function persistEmails(next: string[], previous: string[]) {
    setSaving(true);
    try {
      const updated: DashboardAccessConfig = { cloudEmailAccess: next };
      const response = await fetch("/api/dashboard-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!response.ok) {
        throw new Error(
          await getApiErrorMessage(response, t("publicAccess.dashboardEmails.saveFailedFallback")),
        );
      }
      toast.success(t("publicAccess.dashboardEmails.savedFlash"));
    } catch (error) {
      setEmails(previous);
      toast.error(
        error instanceof Error
          ? error.message
          : t("publicAccess.dashboardEmails.saveFailedFallback"),
      );
    } finally {
      setSaving(false);
    }
  }

  // Moves the addresses in `raw` into the list and auto-saves. Valid ones are
  // appended (deduped); invalid ones stay in the input with an error so the
  // user can fix them.
  function commitDraft(raw: string) {
    const parsed = parseEmailTextarea(raw);
    const seen = new Set(emails);
    const added = parsed.emails.filter((email) => !seen.has(email));
    if (added.length > 0) {
      const next = [...emails, ...added];
      setEmails(next);
      void persistEmails(next, emails);
    }
    if (parsed.invalid.length > 0) {
      setDraft(parsed.invalid.join(" "));
      setDraftError(
        t("publicAccess.dashboardEmails.invalidEmails", {
          emails: parsed.invalid.join(", "),
        }),
      );
      return;
    }
    setDraft("");
    setDraftError("");
  }

  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    commitDraft(`${draft} ${text}`);
  }

  function removeEmail(email: string) {
    const next = emails.filter((entry) => entry !== email);
    setEmails(next);
    void persistEmails(next, emails);
  }

  if (!loaded) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("publicAccess.dashboardEmails.title")}</CardTitle>
        <CardDescription>{t("publicAccess.dashboardEmails.description")}</CardDescription>
        <CardAction>
          <Badge variant="muted">
            {t("publicAccess.dashboardEmails.accountCount", {
              count: emails.length,
            })}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              id="dashboard-cloud-emails"
              size="md"
              icon={<Mail />}
              type="email"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (draftError) setDraftError("");
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitDraft(draft);
              }}
              onPaste={handlePaste}
              disabled={saving}
              placeholder={t("publicAccess.dashboardEmails.placeholder")}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={draftError ? true : undefined}
              aria-label={t("publicAccess.dashboardEmails.inputLabel")}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="md"
            disabled={saving || !draft.trim()}
            onClick={() => commitDraft(draft)}
          >
            {t("publicAccess.dashboardEmails.add")}
          </Button>
        </div>
        {draftError ? (
          <p className="mt-2 text-aux text-destructive-fg">{draftError}</p>
        ) : (
          <p className="mt-2 text-aux text-muted-foreground">
            {t("publicAccess.dashboardEmails.help")}
          </p>
        )}

        {emails.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {emails.map((email) => (
              <li
                key={email}
                className="flex items-center gap-3 rounded-8 border border-border px-3 py-2"
              >
                <Avatar>
                  <AvatarFallback className="bg-primary/15 text-primary">
                    {email[0]?.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-ui text-foreground">{email}</span>
                <IconButton
                  size="sm"
                  label={t("publicAccess.dashboardEmails.remove", { email })}
                  icon={<X />}
                  className="text-muted-foreground hover:text-foreground"
                  disabled={saving}
                  onClick={() => removeEmail(email)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-12 border border-dashed border-border px-3 py-3 text-ui text-muted-foreground">
            {t("publicAccess.dashboardEmails.empty")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TailnetRestrictionSection() {
  const { t } = useTranslation("settings");
  const [config, setConfig] = useState<PublicAccessConfig>({
    enableAccessControl: false,
    allowedApps: [],
    cloudEmailAccess: {},
  });
  const [tailnetDns, setTailnetDns] = useState<string | null>(null);
  const [httpsEnabled, setHttpsEnabled] = useState<boolean | null>(null);
  const [certReady, setCertReady] = useState<boolean | null>(null);
  const [certError, setCertError] = useState<string | null>(null);
  const [tailnetReachable, setTailnetReachable] = useState(false);
  const [checkingTailnetReachable, setCheckingTailnetReachable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState("");
  const [toastIsError, setToastIsError] = useState(false);
  const handoffInFlightRef = useRef(false);

  const fetchTailnetStatus = useCallback(async (): Promise<{
    tailnetDns: string | null;
    httpsEnabled: boolean | null;
    certReady: boolean | null;
    certError: string | null;
  }> => {
    try {
      const response = await fetch("/api/tailnet");
      if (!response.ok) {
        return {
          tailnetDns: null,
          httpsEnabled: null,
          certReady: null,
          certError: null,
        };
      }
      const data = await response.json();
      return {
        tailnetDns: typeof data.tailnetDns === "string" ? data.tailnetDns : null,
        httpsEnabled:
          data.httpsEnabled === true ? true : data.httpsEnabled === false ? false : null,
        certReady: data.certReady === true ? true : data.certReady === false ? false : null,
        certError: typeof data.certError === "string" ? data.certError : null,
      };
    } catch {
      return {
        tailnetDns: null,
        httpsEnabled: null,
        certReady: null,
        certError: null,
      };
    }
  }, []);

  const checkTailnetReachable = useCallback(async (dns: string) => {
    setCheckingTailnetReachable(true);
    try {
      setTailnetReachable(await probeTailnetReachable(dns));
    } finally {
      setCheckingTailnetReachable(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/public-access")
        .then((response) => response.json())
        .catch(() => ({
          enableAccessControl: false,
          allowedApps: [],
          cloudEmailAccess: {},
        })),
      fetchTailnetStatus(),
    ])
      .then(([publicAccess, tailnetStatus]) => {
        const normalized = normalizePublicAccessConfigPayload(publicAccess);
        setConfig(normalized);
        setTailnetDns(tailnetStatus.tailnetDns);
        setHttpsEnabled(tailnetStatus.httpsEnabled);
        setCertReady(tailnetStatus.certReady);
        setCertError(tailnetStatus.certError);
      })
      .finally(() => setLoaded(true));
  }, [fetchTailnetStatus]);

  useEffect(() => {
    if (!tailnetDns || httpsEnabled !== true || certReady !== true || tailnetReachable) {
      if (!tailnetDns || httpsEnabled !== true || certReady !== true) {
        setTailnetReachable(false);
      }
      return;
    }
    checkTailnetReachable(tailnetDns);
    const interval = setInterval(() => checkTailnetReachable(tailnetDns), 5000);
    return () => clearInterval(interval);
  }, [tailnetDns, httpsEnabled, certReady, tailnetReachable, checkTailnetReachable]);

  useEffect(() => {
    if (tailnetDns && httpsEnabled === true && certReady === true) return;
    const interval = setInterval(() => {
      fetchTailnetStatus().then((tailnetStatus) => {
        setTailnetDns(tailnetStatus.tailnetDns);
        setHttpsEnabled(tailnetStatus.httpsEnabled);
        setCertReady(tailnetStatus.certReady);
        setCertError(tailnetStatus.certError);
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [tailnetDns, httpsEnabled, certReady, fetchTailnetStatus]);

  async function save(updated: PublicAccessConfig): Promise<boolean> {
    setSaving(true);
    try {
      const latestTailnetStatus = await fetchTailnetStatus();
      const latestTailnetDns = latestTailnetStatus.tailnetDns;
      const latestHttpsEnabled = latestTailnetStatus.httpsEnabled;
      const latestCertReady = latestTailnetStatus.certReady;
      const latestTailnetReachable =
        latestTailnetDns && latestHttpsEnabled === true && latestCertReady === true
          ? await probeTailnetReachable(latestTailnetDns)
          : false;

      setTailnetDns(latestTailnetDns);
      setHttpsEnabled(latestHttpsEnabled);
      setCertReady(latestCertReady);
      setCertError(latestTailnetStatus.certError);
      setTailnetReachable(latestTailnetReachable);

      const enabling = updated.enableAccessControl && !config.enableAccessControl;
      if (enabling && !accessControlChecksPassed(latestHttpsEnabled, latestTailnetReachable)) {
        throw new Error(t("publicAccess.openFirst"));
      }

      const targetHost = latestTailnetDns?.replace(/\.$/, "") ?? null;
      const needsCrossHostHandoff =
        enabling && !!targetHost && window.location.hostname !== targetHost;

      let handoff: SessionHandoffPayload | null = null;
      if (needsCrossHostHandoff) {
        handoff = await requestSessionHandoff(targetHost, "/settings/tailscale");
        if (!handoff) {
          throw new Error(t("publicAccess.handoffFailed"));
        }
      }

      const response = await fetch("/api/public-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, t("publicAccess.saveFailedFallback")));
      }

      setConfig(updated);
      setToastIsError(false);
      setToast(t("publicAccess.savedFlash"));
      setTimeout(() => setToast(""), 2500);

      if (needsCrossHostHandoff && handoff && !handoffInFlightRef.current) {
        handoffInFlightRef.current = true;
        submitSessionHandoff(targetHost, handoff);
      }
      return true;
    } catch (error) {
      setToastIsError(true);
      setToast(error instanceof Error ? error.message : t("publicAccess.saveFailedFallback"));
      setTimeout(() => setToast(""), 2500);
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  const canTurnOnAccessControl =
    config.enableAccessControl || accessControlChecksPassed(httpsEnabled, tailnetReachable);

  return (
    <div className="mt-6 border-t border-border pt-4">
      {toast && (
        <div
          className={`mb-4 rounded-8 border px-4 py-2 text-ui ${
            toastIsError
              ? "border-destructive-border bg-destructive-bg text-destructive-fg"
              : "border-success-border bg-success-bg text-success-fg"
          }`}
        >
          {toast}
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-ui text-foreground">{t("publicAccess.toggleLabel")}</h4>
          {config.enableAccessControl ? (
            <p className="mt-1 text-aux text-success-fg">{t("publicAccess.restrictedNote")}</p>
          ) : !tailnetDns ? (
            <p className="mt-1 text-aux text-muted-foreground">
              {t("publicAccess.needTailscaleNote")}
            </p>
          ) : httpsEnabled === true && certReady !== true && certError ? (
            <p className="mt-1 text-aux text-warning-fg">{describeTailscaleCertError(certError)}</p>
          ) : httpsEnabled !== true || certReady !== true ? (
            <p className="mt-1 text-aux text-muted-foreground">{t("publicAccess.needHttpsNote")}</p>
          ) : !tailnetReachable ? (
            <p className="mt-1 text-aux text-muted-foreground">
              {t("publicAccess.openTailnetNote")}
              {checkingTailnetReachable ? t("publicAccess.checkingSuffix") : ""}
            </p>
          ) : (
            <p className="mt-1 text-aux text-muted-foreground">
              {t("publicAccess.publicEnabledNote")}
            </p>
          )}
        </div>
        <ToggleSwitch
          checked={config.enableAccessControl}
          onChange={(enableAccessControl) => void save({ ...config, enableAccessControl })}
          disabled={saving || (!config.enableAccessControl && !canTurnOnAccessControl)}
          ariaLabel={t("publicAccess.toggleLabel")}
        />
      </div>
    </div>
  );
}
