import { DevicesSection } from "@/components/devices-section";
import {
  Measure,
  Section,
  SectionHeader,
  SectionHeading,
  SectionTitle,
  SectionDescription,
} from "@rome-os/ui/page";
import { useState, useEffect, useCallback, useId, useRef, type ReactNode } from "react";
import { ComputerUseSection } from "@/components/computer-use-section";
import { SpokenRecapsSection } from "@/components/spoken-recaps-section";
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
import { apiErrorMessageFrom, getApiErrorMessage } from "@/lib/api-error";
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
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowIcon,
  FormRowLabel,
  FormRows,
} from "@rome-os/ui/layout-form";
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
import { useInvalidateSettings } from "@/hooks/use-settings";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useTheme } from "@/hooks/use-theme";
import { parseEmailTextarea } from "@/lib/email-list";
import { StatusIndicator } from "@/lib/connection-status";
import type { ThemePreference } from "@/lib/theme";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";
import type { ComposioCliStatus } from "@/lib/provider-types";
import {
  DASHBOARD_ACCESS_MAX_EMAIL_LENGTH,
  DASHBOARD_ACCESS_MAX_EMAILS,
} from "@rome/api-types/dashboard-access";
import { Page, PageHeader, PageHeading, PageNav, PageNavLink, PageTitle } from "@rome-os/ui/page";
import {
  CONNECTIONS_REFRESH_INTERVAL_MS,
  fetchConnections,
  type ApiConnection,
} from "@/lib/connections-api";

// ── Types ──────────────────────────────────────────────

interface SettingsData {
  "feedback.agentReportsEnabled"?: boolean;
  enableModelSelector?: boolean;
  enableImpersonation?: boolean;
  experimentalConcierge?: boolean;
  showAiToolUsage?: boolean;
  tierModelMappings?: TierModelMappings;
}

type ModelTier = "large" | "medium" | "small";
type ConfigurableProviderId = "openai" | "anthropic";
type TierModelMappings = Partial<
  Record<ConfigurableProviderId, Partial<Record<ModelTier, string>>>
>;

// ── Tabs ───────────────────────────────────────────────

export const TABS = [
  "Appearance",
  "Connections",
  "Devices",
  "Channels",
  "AI Tools",
  "Favors",
  "Advanced",
] as const;

type Tab = (typeof TABS)[number];

// Only these tabs read what `loadAll` fetches (/api/settings). Connections,
// Devices, Channels and Favors own their requests, and Appearance reads the theme/i18n context, so neither the initial settings load
// nor a settings failure has anything to say about them — gating every tab on one
// request would strand a guardian on a healthy tab.
const SETTINGS_BACKED_TABS: ReadonlySet<Tab> = new Set<Tab>(["AI Tools", "Advanced"]);

function tabToSlug(tab: Tab): string {
  return tab.toLowerCase().replace(/\s+/g, "-");
}

export function normalizeTab(value: string | null): Tab | null {
  if (!value) return null;
  return TABS.find((tab) => tabToSlug(tab) === value) ?? null;
}

// ── Component ──────────────────────────────────────────

export default function SettingsPage() {
  const { t } = useTranslation("settings");
  const params = useParams<{ tab?: string }>();
  const normalizedTab = normalizeTab(params.tab ?? null);
  const activeTab = normalizedTab ?? TABS[0];
  useDocumentTitle([t(`tabs.${activeTab}` as const), t("page.title")]);

  const invalidateSettings = useInvalidateSettings();
  const [settings, setSettings] = useState<SettingsData>({});
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [composio, setComposio] = useState<ComposioCliStatus | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
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
        return connectionList;
      } catch (err) {
        console.error("Failed to load connections data", err);
        setConnectionsError(
          err instanceof Error ? err.message : t("connections.loadFailedFallback"),
        );
        return null;
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
      const settingsResponse = await fetch("/api/settings");
      if (!settingsResponse.ok) {
        throw new Error(await getApiErrorMessage(settingsResponse, t("page.loadFailedFallback")));
      }
      setSettings(await settingsResponse.json());
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
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("page.title")}</PageTitle>
        </PageHeading>
      </PageHeader>

      <PageNav aria-label={t("page.title")}>
        {TABS.map((tab) => (
          <PageNavLink asChild key={tab} active={tab === activeTab}>
            <Link to={`/settings/${tabToSlug(tab)}`}>{t(`tabs.${tab}` as const)}</Link>
          </PageNavLink>
        ))}
      </PageNav>

      {tabNeedsSettings && loading ? (
        <p className="text-ui text-muted-foreground">{t("page.loading")}</p>
      ) : tabNeedsSettings && loadError ? (
        <Measure>
          <Card>
            <CardContent className="flex flex-col items-start gap-3">
              <p className="text-ui text-destructive">{loadError}</p>
              <Button type="button" size="sm" onClick={() => void loadAll()}>
                <RefreshCw data-icon="inline-start" />
                {t("page.retry")}
              </Button>
            </CardContent>
          </Card>
        </Measure>
      ) : (
        <>
          {activeTab === "Appearance" && <AppearanceSection />}
          {activeTab === "Connections" && (
            <ConnectionsSection
              connections={connections}
              composio={composio}
              loading={connectionsLoading}
              error={connectionsError}
              onRefresh={loadConnections}
              onFlash={(message) => toast.error(message)}
            />
          )}
          {activeTab === "Devices" && <DevicesSection />}
          {activeTab === "Channels" && (
            <div className="max-w-3xl">
              <ChannelsSettingsPage />
            </div>
          )}
          {activeTab === "Favors" && (
            <Measure>
              <FavorsSection />
            </Measure>
          )}
          {activeTab === "AI Tools" && (
            <AiToolsPanel showRomeCredits showUsage={settings.showAiToolUsage ?? true} />
          )}
          {activeTab === "Advanced" && (
            <AdvancedSection settings={settings} onSave={saveSettings} saving={saving} />
          )}
        </>
      )}
    </Page>
  );
}

/**
 * The Appearance tab, on the kit's Form layout. The tab's body fills Form's
 * rows slot — `FormRows` caps the reading measure and each `FormRow` carries
 * one setting, label left and control right — while the Settings title and tab
 * strip above stay the shared frame all tabs render into.
 *
 * Rows rather than stacked fields, because a guardian returns here to change
 * one setting at a time, and every row saves itself the moment it changes.
 */
function AppearanceSection() {
  const { t, i18n } = useTranslation("settings");
  const { theme, setTheme, themes, preference, setPreference } = useTheme();
  const uid = useId();

  const currentLang: SupportedLanguage = (SUPPORTED_LANGUAGES as readonly string[]).includes(
    i18n.resolvedLanguage ?? "",
  )
    ? (i18n.resolvedLanguage as SupportedLanguage)
    : "en";

  const modeIcon =
    preference === "dark" ? <Moon /> : preference === "light" ? <Sun /> : <Monitor />;

  return (
    <FormRows>
      <FormRow>
        <FormRowIcon>
          <Languages />
        </FormRowIcon>
        <FormRowHeading>
          <FormRowLabel htmlFor={`${uid}-language`}>{t("appearance.language.title")}</FormRowLabel>
        </FormRowHeading>
        <FormRowControl>
          <Select
            value={currentLang}
            onValueChange={(next) => {
              void i18n.changeLanguage(next);
            }}
          >
            {/* `aria-label` alongside the label element: a Radix trigger is a
              `button`, and a button takes its accessible name from its own
              content, so the visible label would leave the name reading as the
              selected value. */}
            <SelectTrigger id={`${uid}-language`} aria-label={t("appearance.language.title")}>
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
        </FormRowControl>
      </FormRow>

      <FormRow>
        <FormRowIcon>
          <Palette />
        </FormRowIcon>
        <FormRowHeading>
          <FormRowLabel htmlFor={`${uid}-theme`}>{t("appearance.theme.title")}</FormRowLabel>
        </FormRowHeading>
        <FormRowControl>
          <Select value={theme} onValueChange={(next) => setTheme(next)}>
            <SelectTrigger id={`${uid}-theme`} aria-label={t("appearance.theme.title")}>
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
        </FormRowControl>
      </FormRow>

      <FormRow>
        <FormRowIcon>{modeIcon}</FormRowIcon>
        <FormRowHeading>
          <FormRowLabel htmlFor={`${uid}-mode`}>{t("appearance.mode.title")}</FormRowLabel>
        </FormRowHeading>
        <FormRowControl>
          <Select
            value={preference}
            onValueChange={(next) => setPreference(next as ThemePreference)}
          >
            <SelectTrigger id={`${uid}-mode`} aria-label={t("appearance.mode.title")}>
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
        </FormRowControl>
      </FormRow>
    </FormRows>
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
          {summary && <p className="mt-1 text-ui text-muted-foreground">{summary}</p>}
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
                  <Spinner
                    data-icon="inline-start"
                    size="sm"
                    label={t("favors.payingApprovalRequest")}
                  />
                ) : (
                  <Check data-icon="inline-start" />
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
                  <Spinner
                    data-icon="inline-start"
                    size="sm"
                    label={t("favors.decliningApprovalRequest")}
                  />
                ) : (
                  <X data-icon="inline-start" />
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
            <RefreshCw data-icon="inline-start" />
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
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Favors</SectionTitle>
          <SectionDescription>
            Balance, payments, and paid app actions settled through Rome Cloud.
          </SectionDescription>
        </SectionHeading>
      </SectionHeader>

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

      <Section className="gap-0 overflow-hidden rounded-12 border border-border bg-surface">
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
                align="between"
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
      </Section>

      <Section className="gap-0 overflow-hidden rounded-12 border border-border bg-surface">
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
      </Section>

      {failed.length > 0 && (
        <Section className="gap-0 overflow-hidden rounded-12 border border-border bg-surface">
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
        </Section>
      )}

      <Section className="gap-0 overflow-hidden rounded-12 border border-border bg-surface">
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
      </Section>

      <Section className="gap-0 overflow-hidden rounded-12 border border-border bg-surface">
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
      </Section>
    </Section>
  );
}

function AdvancedSection({
  settings,
  onSave,
  saving,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
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
    <Measure>
      <Section className="gap-6">
        <SectionHeader>
          <SectionTitle>{t("advanced.title")}</SectionTitle>
        </SectionHeader>
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
        {!isElectronShell() && <SystemUpgradeSection />}
        <AccessControlSection />
        <SystemDiagnosisSection />
        <Section>
          <SectionHeader>
            <SectionTitle>{t("advanced.feedback.title")}</SectionTitle>
          </SectionHeader>
          <FormRows>
            <SettingsToggleRow
              title={t("advanced.feedback.agentReports.title")}
              description={t("advanced.feedback.agentReports.description")}
              label={t("advanced.feedback.agentReports.toggleLabel")}
              checked={settings["feedback.agentReportsEnabled"] ?? true}
              onChange={(enabled) => void onSave({ "feedback.agentReportsEnabled": enabled })}
              disabled={saving}
            />
          </FormRows>
        </Section>
        <SpokenRecapsSection />
        <ComputerUseSection />
        <PresentationModeSection />
        <ExperimentalFeaturesSection settings={settings} onSave={onSave} saving={saving} />
        <DeveloperSettingsSection settings={settings} onSave={onSave} saving={saving} />
        {showEasterEgg && <AdvancedEasterEggOverlay onClose={() => setShowEasterEgg(false)} />}
      </Section>
    </Measure>
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
    <FormRows>
      <SettingsToggleRow
        title={t("advanced.presentationMode.title")}
        description={t("advanced.presentationMode.description")}
        label={t("advanced.presentationMode.toggleLabel")}
        checked={enabled}
        onChange={setPresentationMode}
      />
    </FormRows>
  );
}

function SettingsToggleRow({
  title,
  description,
  label,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description?: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <FormRow>
      <FormRowHeading>
        <FormRowLabel htmlFor={id}>{title}</FormRowLabel>
        {description && <FormRowDescription>{description}</FormRowDescription>}
        <FormRowLabel htmlFor={id} className="text-aux text-muted-foreground">
          {label}
        </FormRowLabel>
      </FormRowHeading>
      <FormRowControl>
        <Switch
          id={id}
          aria-label={label}
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      </FormRowControl>
    </FormRow>
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
      <Section className="mt-3">
        <FormRows>
          <TierModelMappingsAdvancedSection settings={settings} onSave={onSave} saving={saving} />
          <ModelSelectorAdvancedSection settings={settings} onSave={onSave} saving={saving} />
          <ImpersonationAdvancedSection settings={settings} onSave={onSave} saving={saving} />
          <AiToolUsageAdvancedSection settings={settings} onSave={onSave} saving={saving} />
        </FormRows>
        {open && <RelayHealthSection />}
      </Section>
    </details>
  );
}

const TIER_MODEL_MAPPING_FIELDS: Array<{
  provider: ConfigurableProviderId;
  tier: ModelTier;
  placeholder: string;
}> = [
  { provider: "openai", tier: "large", placeholder: "gpt-6.1-sol" },
  { provider: "openai", tier: "medium", placeholder: "gpt-6.1-sol" },
  { provider: "openai", tier: "small", placeholder: "gpt-6-luna" },
  { provider: "anthropic", tier: "large", placeholder: "claude-opus-5-5[1m]" },
  { provider: "anthropic", tier: "medium", placeholder: "claude-sonnet-5-5" },
  { provider: "anthropic", tier: "small", placeholder: "claude-haiku-5-5" },
];

function normalizeTierModelMappings(value: unknown): TierModelMappings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const mappings: TierModelMappings = {};
  for (const provider of ["openai", "anthropic"] as const) {
    const providerMappings = (value as Record<string, unknown>)[provider];
    if (
      !providerMappings ||
      typeof providerMappings !== "object" ||
      Array.isArray(providerMappings)
    ) {
      continue;
    }
    for (const tier of ["large", "medium", "small"] as const) {
      const model = (providerMappings as Record<string, unknown>)[tier];
      if (typeof model === "string" && model.trim()) {
        mappings[provider] = { ...mappings[provider], [tier]: model.trim() };
      }
    }
  }
  return mappings;
}

function TierModelMappingsAdvancedSection({
  settings,
  onSave,
  saving,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation("settings");
  const [mappings, setMappings] = useState(() =>
    normalizeTierModelMappings(settings.tierModelMappings),
  );

  function update(provider: ConfigurableProviderId, tier: ModelTier, model: string) {
    setMappings((current) => ({
      ...current,
      [provider]: { ...current[provider], [tier]: model },
    }));
  }

  function save() {
    const normalized = normalizeTierModelMappings(mappings);
    setMappings(normalized);
    void onSave({ tierModelMappings: normalized });
  }

  return (
    <FormRow className="block">
      <FormRowHeading>
        <FormRowLabel>{t("advanced.tierModelMappings.title")}</FormRowLabel>
        <FormRowDescription>{t("advanced.tierModelMappings.description")}</FormRowDescription>
      </FormRowHeading>
      <FormRows className="mt-3 max-w-none">
        {TIER_MODEL_MAPPING_FIELDS.map(({ provider, tier, placeholder }) => {
          const id = `tier-model-${provider}-${tier}`;
          return (
            <FormRow key={id}>
              <FormRowHeading>
                <FormRowLabel htmlFor={id}>
                  {t(`advanced.tierModelMappings.${provider}.${tier}`)}
                </FormRowLabel>
              </FormRowHeading>
              <FormRowControl>
                <Input
                  id={id}
                  className="w-64"
                  value={mappings[provider]?.[tier] ?? ""}
                  placeholder={placeholder}
                  onChange={(event) => update(provider, tier, event.target.value)}
                  disabled={saving}
                />
              </FormRowControl>
            </FormRow>
          );
        })}
      </FormRows>
      <Button type="button" size="sm" className="mt-3" onClick={save} disabled={saving}>
        {t("advanced.tierModelMappings.save")}
      </Button>
    </FormRow>
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
    <SettingsToggleRow
      title={t("advanced.modelSelector.title")}
      label={t("advanced.modelSelector.toggleLabel")}
      checked={enabled}
      onChange={toggle}
      disabled={saving}
    />
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
    <SettingsToggleRow
      title={t("advanced.impersonation.title")}
      label={t("advanced.impersonation.toggleLabel")}
      checked={enabled}
      onChange={toggle}
      disabled={saving}
    />
  );
}

/** Features still being tried out, each off until a guardian switches it on.
 *  `experimentalConcierge` shows the Concierge chat under Chats. */
function ExperimentalFeaturesSection({
  settings,
  onSave,
  saving,
}: {
  settings: SettingsData;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation("settings");
  const [concierge, setConcierge] = useState(settings.experimentalConcierge ?? false);

  function toggleConcierge(next: boolean) {
    setConcierge(next);
    void onSave({ experimentalConcierge: next });
  }

  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>{t("advanced.experimental.title")}</SectionTitle>
          <SectionDescription>{t("advanced.experimental.description")}</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <FormRows>
        <SettingsToggleRow
          title={t("advanced.experimental.concierge.title")}
          description={t("advanced.experimental.concierge.description")}
          label={t("advanced.experimental.concierge.toggleLabel")}
          checked={concierge}
          onChange={toggleConcierge}
          disabled={saving}
        />
      </FormRows>
    </Section>
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
  const [enabled, setEnabled] = useState(settings.showAiToolUsage ?? true);

  function toggle(next: boolean) {
    setEnabled(next);
    void onSave({ showAiToolUsage: next });
  }

  return (
    <SettingsToggleRow
      title={t("advanced.aiToolUsage.title")}
      description={t("advanced.aiToolUsage.description")}
      label={t("advanced.aiToolUsage.toggleLabel")}
      checked={enabled}
      onChange={toggle}
      disabled={saving}
    />
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

// ── Section: Access Control ───────────────────────────
// Who can sign in from the public host (allowed Rome Cloud emails).

function AccessControlSection() {
  const { t } = useTranslation("settings");
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>{t("publicAccess.title")}</SectionTitle>
          <SectionDescription>{t("publicAccess.description")}</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <AllowedCloudEmailsSection />
    </Section>
  );
}

interface DashboardAccessConfig {
  cloudEmailAccess: string[];
}

function AllowedCloudEmailsSection() {
  const { t } = useTranslation("settings");
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchJson<DashboardAccessConfig>("/api/dashboard-access", {
      fallback: "Failed to load dashboard access.",
    })
      .catch((): DashboardAccessConfig => ({ cloudEmailAccess: [] }))
      .then((dashboardAccess) => setEmails(dashboardAccess.cloudEmailAccess))
      .finally(() => setLoaded(true));
  }, []);

  // A save past a limit names the limit. Anything else shows the server's message.
  async function saveErrorMessage(response: Response): Promise<string> {
    const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (data?.error === "too_many_emails") {
      return t("publicAccess.dashboardEmails.tooMany", { limit: DASHBOARD_ACCESS_MAX_EMAILS });
    }
    if (data?.error === "email_too_long") {
      return t("publicAccess.dashboardEmails.emailTooLong", {
        limit: DASHBOARD_ACCESS_MAX_EMAIL_LENGTH,
      });
    }
    return apiErrorMessageFrom(data, t("publicAccess.dashboardEmails.saveFailedFallback"));
  }

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
      if (!response.ok) throw new Error(await saveErrorMessage(response));
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
