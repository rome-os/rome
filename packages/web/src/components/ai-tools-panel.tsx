import { lazy, Suspense, useCallback, useEffect, useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";

import {
  AI_TOOL_ACTION_BUTTON_CLASS,
  AiToolSignInButtons,
  type AiToolSignInMethod,
} from "@/components/ai-tool-sign-in-buttons";
import {
  AiToolBrandIcon,
  ModelProviderIcon,
  RomeCodexLockup,
  type AiToolBrandIconName,
} from "@/components/brand-icons/ai-tool-icons";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { EmptyState, EmptyStateTitle } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  CUSTOM_ANTHROPIC_PROVIDER_ID,
  type AnthropicCompatibleConfigurationId,
  type AnthropicCompatibleProviderSummary,
} from "@rome/api-types/anthropic-compatible-providers";

const TerminalModal = lazy(() => import("@/components/terminal-modal"));
const ChatGPTLoginModal = lazy(() =>
  import("@/components/chatgpt-login-modal").then((mod) => ({ default: mod.ChatGPTLoginModal })),
);
const CodexDeviceLoginModal = lazy(() =>
  import("@/components/codex-device-login-modal").then((mod) => ({
    default: mod.CodexDeviceLoginModal,
  })),
);

// ── Section: AI Tools ──────────────────────────────────

export interface AIToolStatus {
  loggedIn: boolean;
  email?: string;
  authMethod?: string;
  accountType?: string;
  usage?: AIToolUsageStatus;
  /**
   * Credentials are present but proven revoked server-side (Codex's refresh
   * token was revoked): `loggedIn` is false and the badge reads "needs
   * re-login" rather than a plain "not connected".
   */
  needsReauth?: boolean;
}

interface UsageWindowStatus {
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
}

interface AIToolUsageStatus {
  checkedAt: string;
  source: string;
  fiveHour?: UsageWindowStatus;
  sevenDay?: UsageWindowStatus;
  error?: string;
}

type AIToolStatusMap = Record<string, AIToolStatus>;

export type { AnthropicCompatibleProviderSummary };

export interface AnthropicCompatibleConfiguredSummary {
  provider: AnthropicCompatibleConfigurationId;
  providerName: string;
  hasApiKey: boolean;
  updatedAt: string;
  needsReauth?: boolean;
  env?: Record<string, string>;
}

type AnthropicEnvEditorMode = "json" | "fields";

interface AnthropicEnvEntry {
  id: string;
  key: string;
  value: string;
}

let nextAnthropicEnvEntryId = 0;

function createAnthropicEnvEntry(key = "", value = ""): AnthropicEnvEntry {
  nextAnthropicEnvEntryId += 1;
  return { id: `anthropic-env-${nextAnthropicEnvEntryId}`, key, value };
}

function configuredCustomEnvEntries(
  configured: AnthropicCompatibleConfiguredSummary | null,
): AnthropicEnvEntry[] {
  if (configured?.provider !== CUSTOM_ANTHROPIC_PROVIDER_ID) return [];
  return Object.entries(configured.env ?? {}).map(([key, value]) =>
    createAnthropicEnvEntry(key, value),
  );
}

function serializeAnthropicEnvEntries(entries: AnthropicEnvEntry[]): string {
  const env = Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
  return JSON.stringify({ env }, null, 2);
}

function parseAnthropicEnvJson(
  text: string,
): { entries: AnthropicEnvEntry[]; error: null } | { entries: null; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: null, error: "invalidJson" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { entries: null, error: "envMustBeObject" };
  }
  const record = parsed as Record<string, unknown>;
  const candidate = "env" in record ? record.env : record;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { entries: null, error: "envMustBeObject" };
  }

  const entries: AnthropicEnvEntry[] = [];
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return { entries: null, error: "valuesMustBeStrings" };
    }
    entries.push(createAnthropicEnvEntry(key, value));
  }
  return { entries, error: null };
}

function buildCustomAnthropicEnvRequest(
  entries: AnthropicEnvEntry[],
):
  | { env: Record<string, string> }
  | { error: "emptyKey" | "emptyValue" | "duplicateKey" | "emptyEnv" } {
  if (entries.length === 0) return { error: "emptyEnv" };
  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.key) return { error: "emptyKey" };
    if (entry.key in env) return { error: "duplicateKey" };
    if (!entry.value) return { error: "emptyValue" };
    env[entry.key] = entry.value;
  }
  return { env };
}

const AI_TOOL_PROVIDERS = [
  {
    id: "codex-login",
    i18nKey: "codex" as const,
    available: true,
    statusKey: "codex" as const,
    icon: "chatgpt" as const,
  },
  {
    id: "claude-login",
    i18nKey: "claudeCode" as const,
    available: true,
    statusKey: "claude" as const,
    icon: "claude" as const,
  },
  {
    id: "gemini-login",
    i18nKey: "geminiCli" as const,
    available: false,
    statusKey: "gemini" as const,
    icon: "gemini" as const,
  },
  {
    id: "grok-login",
    i18nKey: "grok" as const,
    available: false,
    statusKey: "grok" as const,
    icon: "grok" as const,
  },
] as const;

export type AiToolProviderId = (typeof AI_TOOL_PROVIDERS)[number]["statusKey"];

const LOGOUT_PROVIDER_CONFIG = {
  claude: {
    icon: undefined,
    titleKey: "aiTools.claudeLogout.title",
    descriptionKey: "aiTools.claudeLogout.description",
    failedKey: "aiTools.claudeLogout.failed",
  },
  codex: {
    icon: <RomeCodexLockup />,
    titleKey: "aiTools.codexLogout.title",
    descriptionKey: "aiTools.codexLogout.description",
    failedKey: "aiTools.codexLogout.failed",
  },
} as const;

type LogoutProvider = keyof typeof LOGOUT_PROVIDER_CONFIG;

interface AiToolsPanelProps {
  hiddenProviders?: readonly AiToolProviderId[];
  showUsage?: boolean;
  showHeader?: boolean;
  onConnectedChange?: (connected: boolean) => void;
}

const AI_TOOLS_STATUS_REFRESH_MS = 30 * 60 * 1000;

function getSignInMethods(
  providerId: string,
  t: (key: string) => string,
  handlers: {
    openChatgptModal: () => void;
    openDeviceLogin: () => void;
    openTerminal: (preset: string) => void;
  },
): AiToolSignInMethod[] {
  if (providerId === "codex-login") {
    return [
      {
        id: "browser",
        label: t("aiTools.methods.browser"),
        onClick: handlers.openChatgptModal,
      },
      {
        id: "deviceCode",
        label: t("aiTools.methods.deviceCode"),
        onClick: handlers.openDeviceLogin,
      },
    ];
  }
  return [
    {
      id: "terminal",
      label: t("aiTools.logIn"),
      onClick: () => handlers.openTerminal(providerId),
    },
  ];
}

function formatAccountType(value: string | undefined): string | null {
  if (!value) return null;
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatResetIn(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return null;
  const totalMinutes = Math.floor(diffMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  if (days >= 1) {
    const h = totalHours % 24;
    return h > 0 ? `${days}d ${h}h` : `${days}d`;
  }
  if (totalHours >= 1) {
    const m = totalMinutes % 60;
    return m > 0 ? `${totalHours}h ${m}m` : `${totalHours}h`;
  }
  return `${Math.max(1, totalMinutes)}m`;
}

type UsageTone = "success" | "warning" | "destructive" | "muted";

const WINDOW_DURATION_MS: Record<"fiveHour" | "sevenDay", number> = {
  fiveHour: 5 * 60 * 60_000,
  sevenDay: 7 * 24 * 60 * 60_000,
};

function getTimeElapsedPercent(
  resetsAt: string | undefined,
  windowKey: "fiveHour" | "sevenDay",
): number | undefined {
  if (!resetsAt) return undefined;
  const resetMs = new Date(resetsAt).getTime();
  if (Number.isNaN(resetMs)) return undefined;
  const durationMs = WINDOW_DURATION_MS[windowKey];
  const remainingMs = resetMs - Date.now();
  if (remainingMs <= 0) return 100;
  if (remainingMs >= durationMs) return 0;
  return ((durationMs - remainingMs) / durationMs) * 100;
}

function getUsageTone(
  usagePercent: number | undefined,
  timePercent: number | undefined,
): UsageTone {
  if (usagePercent === undefined || !Number.isFinite(usagePercent)) return "muted";
  if (usagePercent < 10) return "success";
  if (timePercent === undefined || !Number.isFinite(timePercent) || timePercent <= 0) {
    return usagePercent > 98 ? "destructive" : "muted";
  }
  const ratio = usagePercent / timePercent;
  if (ratio < 0.85) return "success";
  if (ratio > 1.15 || usagePercent > 98 || usagePercent - timePercent > 10) {
    return "destructive";
  }
  return "warning";
}

const USAGE_TONE_CLASSES: Record<UsageTone, { bar: string; text: string }> = {
  success: { bar: "bg-success", text: "text-success-fg" },
  warning: { bar: "bg-warning", text: "text-warning-fg" },
  destructive: { bar: "bg-destructive", text: "text-destructive-fg" },
  muted: { bar: "bg-border-strong", text: "text-muted-foreground" },
};

function UsageBar({
  label,
  window,
  windowKey,
  resetsInLabel,
}: {
  label: string;
  window: UsageWindowStatus | undefined;
  windowKey: "fiveHour" | "sevenDay";
  resetsInLabel: string;
}) {
  const usagePercent = window?.usedPercent;
  const timePercent = getTimeElapsedPercent(window?.resetsAt, windowKey);
  const tone = getUsageTone(usagePercent, timePercent);
  const classes = USAGE_TONE_CLASSES[tone];
  const usageWidth =
    usagePercent !== undefined && Number.isFinite(usagePercent)
      ? Math.min(100, Math.max(0, usagePercent))
      : 0;
  const resetText = formatResetIn(window?.resetsAt);
  const hasMarker = timePercent !== undefined && Number.isFinite(timePercent);
  const markerLeft = hasMarker ? Math.min(98, Math.max(2, timePercent!)) : null;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-aux text-muted-foreground">{label}</span>
        <span className={`text-title ${classes.text}`}>
          {usagePercent !== undefined && Number.isFinite(usagePercent)
            ? Math.round(usagePercent)
            : "—"}
          <span className="ml-1 text-ui">%</span>
        </span>
      </div>
      <div className="relative mt-2 h-2 rounded-full bg-border-subtle">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${classes.bar}`}
          style={{ width: `${usageWidth}%` }}
        />
        {markerLeft !== null && (
          <div
            className="absolute top-[-3px] bottom-[-3px] w-px bg-foreground"
            style={{ left: `${markerLeft}%` }}
            aria-hidden
          />
        )}
      </div>
      {resetText && markerLeft !== null && (
        <div className="relative mt-1 h-4">
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap text-aux text-muted-foreground"
            style={{ left: `${markerLeft}%` }}
          >
            <Trans
              i18nKey={resetsInLabel}
              values={{ time: resetText }}
              components={{ 1: <span className="text-foreground" /> }}
            />
          </span>
        </div>
      )}
    </div>
  );
}

function AiToolIcon({ icon }: { icon: AiToolBrandIconName }) {
  const color =
    icon === "claude" ? "text-[#d97757]" : icon === "gemini" ? "text-[#4285f4]" : "text-foreground";
  return (
    <span className={`flex size-7 shrink-0 items-center justify-center ${color}`} aria-hidden>
      <AiToolBrandIcon icon={icon} className="size-5" />
    </span>
  );
}

function AnthropicCompatibleProviderLogo({ providerId }: { providerId: string }) {
  if (providerId === CUSTOM_ANTHROPIC_PROVIDER_ID) {
    return (
      <span aria-hidden>
        <AiToolBrandIcon icon="claude" className="size-4 shrink-0 text-[#d97757]" />
      </span>
    );
  }
  return (
    <ModelProviderIcon
      provider={providerId}
      fallback={false}
      className="size-4 shrink-0 object-contain"
    />
  );
}

export function shouldShowAiToolUsage(
  showAiToolUsage: boolean,
  status: AIToolStatus | undefined,
  available: boolean,
): boolean {
  return showAiToolUsage && available && status?.loggedIn === true;
}

export function AiToolsPanel({
  hiddenProviders = [],
  showUsage = false,
  showHeader = true,
  onConnectedChange,
}: AiToolsPanelProps) {
  const { t } = useTranslation("settings");
  const uid = useId();
  const [terminalPreset, setTerminalPreset] = useState<string | null>(null);
  const [chatgptModalOpen, setChatgptModalOpen] = useState(false);
  const [deviceLoginModalOpen, setDeviceLoginModalOpen] = useState(false);
  const [anthropicProviderDialogOpen, setAnthropicProviderDialogOpen] = useState(false);
  const [logoutProvider, setLogoutProvider] = useState<LogoutProvider | null>(null);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [removeAnthropicProviderOpen, setRemoveAnthropicProviderOpen] = useState(false);
  const [toolStatus, setToolStatus] = useState<AIToolStatusMap>({});
  const [anthropicProviders, setAnthropicProviders] = useState<
    AnthropicCompatibleProviderSummary[]
  >([]);
  const [configuredAnthropicProvider, setConfiguredAnthropicProvider] =
    useState<AnthropicCompatibleConfiguredSummary | null>(null);
  const [selectedAnthropicProvider, setSelectedAnthropicProvider] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicEnvEditorMode, setAnthropicEnvEditorMode] =
    useState<AnthropicEnvEditorMode>("json");
  const [anthropicEnvEntries, setAnthropicEnvEntries] = useState<AnthropicEnvEntry[]>([]);
  const [anthropicEnvJson, setAnthropicEnvJson] = useState(() => serializeAnthropicEnvEntries([]));
  const [anthropicEnvError, setAnthropicEnvError] = useState<string | null>(null);
  const [savingAnthropicProvider, setSavingAnthropicProvider] = useState(false);
  const [anthropicProviderMessage, setAnthropicProviderMessage] = useState("");
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const fetchAnthropicProviders = useCallback(async () => {
    const res = await fetch("/api/ai-tools/anthropic-compatible-providers");
    const data = (await res.json()) as {
      providers?: AnthropicCompatibleProviderSummary[];
      configured?: AnthropicCompatibleConfiguredSummary | null;
    };
    const providers = Array.isArray(data.providers) ? data.providers : [];
    setAnthropicProviders(providers);
    setConfiguredAnthropicProvider(data.configured ?? null);
    setSelectedAnthropicProvider(
      (current) => current || data.configured?.provider || providers[0]?.id || "",
    );
  }, []);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/api/ai-tools/status");
      const data = (await res.json()) as {
        claude?: AIToolStatus;
        codex?: AIToolStatus;
        anthropicCompatible?: AnthropicCompatibleConfiguredSummary | null;
      };
      setToolStatus({
        ...(data.claude ? { claude: data.claude } : {}),
        ...(data.codex ? { codex: data.codex } : {}),
      });
      setConfiguredAnthropicProvider((current) => {
        const next = data.anthropicCompatible ?? null;
        if (
          next?.provider === CUSTOM_ANTHROPIC_PROVIDER_ID &&
          current?.provider === CUSTOM_ANTHROPIC_PROVIDER_ID
        ) {
          return {
            ...next,
            env: current.env,
          };
        }
        return next;
      });
    } catch {
      /* ignore */
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus().catch(() => {
      /* ignore */
    });
    fetchAnthropicProviders().catch(() => {
      /* ignore */
    });
  }, [fetchStatus, fetchAnthropicProviders]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void fetchStatus();
    }, AI_TOOLS_STATUS_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [fetchStatus]);

  function handleTerminalClose() {
    setTerminalPreset(null);
    // Re-fetch status in case the user just logged in
    fetchStatus().catch(() => {
      /* ignore */
    });
  }

  function resetCustomEnvEditor(configured = configuredAnthropicProvider) {
    const entries = configuredCustomEnvEntries(configured);
    setAnthropicEnvEntries(entries);
    setAnthropicEnvJson(serializeAnthropicEnvEntries(entries));
    setAnthropicEnvEditorMode("json");
    setAnthropicEnvError(null);
  }

  function openAnthropicProviderDialog() {
    setAnthropicProviderMessage("");
    setSelectedAnthropicProvider(
      configuredAnthropicProvider?.provider || anthropicProviders[0]?.id || "",
    );
    resetCustomEnvEditor();
    setAnthropicProviderDialogOpen(true);
  }

  function closeAnthropicProviderDialog() {
    setAnthropicProviderDialogOpen(false);
    setAnthropicApiKey("");
    setAnthropicProviderMessage("");
    setAnthropicEnvError(null);
  }

  function handleAnthropicProviderChange(provider: string) {
    setSelectedAnthropicProvider(provider);
    setAnthropicProviderMessage("");
    if (provider === CUSTOM_ANTHROPIC_PROVIDER_ID) {
      resetCustomEnvEditor(
        configuredAnthropicProvider?.provider === CUSTOM_ANTHROPIC_PROVIDER_ID
          ? configuredAnthropicProvider
          : null,
      );
    }
  }

  function handleAnthropicEnvJsonChange(value: string) {
    setAnthropicEnvJson(value);
    const parsed = parseAnthropicEnvJson(value);
    if (!parsed.entries) {
      setAnthropicEnvError(parsed.error);
      return;
    }
    setAnthropicEnvEntries(parsed.entries);
    setAnthropicEnvError(null);
  }

  function handleAnthropicEnvEditorModeChange(mode: string) {
    if (mode !== "json" && mode !== "fields") return;
    if (mode === "fields") {
      const parsed = parseAnthropicEnvJson(anthropicEnvJson);
      if (!parsed.entries) {
        setAnthropicEnvError(parsed.error);
        return;
      }
      setAnthropicEnvEntries(parsed.entries);
      setAnthropicEnvError(null);
    } else {
      const keys = anthropicEnvEntries.map((entry) => entry.key);
      if (new Set(keys).size !== keys.length) {
        setAnthropicEnvError("duplicateKey");
        return;
      }
      setAnthropicEnvJson(serializeAnthropicEnvEntries(anthropicEnvEntries));
      setAnthropicEnvError(null);
    }
    setAnthropicEnvEditorMode(mode);
  }

  function updateAnthropicEnvEntry(id: string, field: "key" | "value", value: string) {
    setAnthropicEnvEntries((entries) =>
      entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              [field]: value,
            }
          : entry,
      ),
    );
    setAnthropicEnvError(null);
  }

  async function handleRefresh() {
    setRefreshPending(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/ai-tools/refresh", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        claude?: AIToolStatus;
        codex?: AIToolStatus;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || t("aiTools.refreshFailed"));
      setToolStatus({
        ...(data.claude ? { claude: data.claude } : {}),
        ...(data.codex ? { codex: data.codex } : {}),
      });
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : t("aiTools.refreshFailed"));
    } finally {
      setRefreshPending(false);
    }
  }

  async function handleLogout() {
    if (!logoutProvider) return;
    const provider = logoutProvider;
    const config = LOGOUT_PROVIDER_CONFIG[provider];
    const fallbackError = t(config.failedKey);
    setLogoutPending(true);
    setLogoutError(null);
    try {
      const res = await fetch(`/api/ai-tools/${provider}/logout`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setLogoutError(data.error || fallbackError);
        return;
      }
      setLogoutProvider(null);
      await fetchStatus();
    } catch {
      setLogoutError(fallbackError);
    } finally {
      setLogoutPending(false);
    }
  }

  async function saveAnthropicProviderCredentials() {
    setSavingAnthropicProvider(true);
    setAnthropicProviderMessage("");
    try {
      let requestBody: Record<string, unknown>;
      if (selectedAnthropicProvider === CUSTOM_ANTHROPIC_PROVIDER_ID) {
        let entries = anthropicEnvEntries;
        if (anthropicEnvEditorMode === "json") {
          const parsed = parseAnthropicEnvJson(anthropicEnvJson);
          if (!parsed.entries) {
            setAnthropicEnvError(parsed.error);
            return;
          }
          entries = parsed.entries;
          setAnthropicEnvEntries(entries);
        }
        const custom = buildCustomAnthropicEnvRequest(entries);
        if ("error" in custom) {
          setAnthropicEnvError(custom.error);
          return;
        }
        requestBody = {
          provider: CUSTOM_ANTHROPIC_PROVIDER_ID,
          env: custom.env,
        };
      } else {
        requestBody = {
          provider: selectedAnthropicProvider,
          apiKey: anthropicApiKey,
        };
      }
      const res = await fetch("/api/ai-tools/anthropic-compatible-credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        throw new Error(
          await getApiErrorMessage(res, t("aiTools.otherProviders.saveFailedFallback")),
        );
      }
      const data = (await res.json()) as {
        configured?: AnthropicCompatibleConfiguredSummary | null;
      };
      setConfiguredAnthropicProvider(data.configured ?? null);
      setAnthropicApiKey("");
      await fetchStatus();
      setAnthropicProviderDialogOpen(false);
    } catch (error) {
      setAnthropicProviderMessage(
        error instanceof Error ? error.message : t("aiTools.otherProviders.saveFailedFallback"),
      );
    } finally {
      setSavingAnthropicProvider(false);
    }
  }

  async function clearAnthropicProviderCredentials() {
    setSavingAnthropicProvider(true);
    setAnthropicProviderMessage("");
    try {
      const res = await fetch("/api/ai-tools/anthropic-compatible-credentials", {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(
          await getApiErrorMessage(res, t("aiTools.otherProviders.removeFailedFallback")),
        );
      }
      setConfiguredAnthropicProvider(null);
      setRemoveAnthropicProviderOpen(false);
      await fetchStatus();
    } catch (error) {
      setAnthropicProviderMessage(
        error instanceof Error ? error.message : t("aiTools.otherProviders.removeFailedFallback"),
      );
      setRemoveAnthropicProviderOpen(false);
      setAnthropicProviderDialogOpen(true);
    } finally {
      setSavingAnthropicProvider(false);
    }
  }

  const selectedProvider = anthropicProviders.find(
    (provider) => provider.id === selectedAnthropicProvider,
  );
  const visibleProviders = AI_TOOL_PROVIDERS.filter(
    (provider) => !hiddenProviders.includes(provider.statusKey),
  );
  const anyConnected = visibleProviders.some(
    (provider) => toolStatus[provider.statusKey]?.loggedIn === true,
  );
  const logoutConfig = logoutProvider ? LOGOUT_PROVIDER_CONFIG[logoutProvider] : null;

  useEffect(() => {
    if (!loadingStatus) onConnectedChange?.(anyConnected);
  }, [anyConnected, loadingStatus, onConnectedChange]);

  return (
    <div>
      {showHeader && (
        <>
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-title text-foreground">{t("aiTools.title")}</h2>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleRefresh()}
              disabled={refreshPending}
              className={`shrink-0 ${AI_TOOL_ACTION_BUTTON_CLASS}`}
            >
              {refreshPending ? (
                <Spinner size="sm" aria-hidden />
              ) : (
                <RefreshCw className="size-4" aria-hidden />
              )}
              {refreshPending ? t("aiTools.refreshing") : t("aiTools.refresh")}
            </Button>
          </div>
          {refreshError && (
            <p role="alert" className="mb-4 text-body text-destructive">
              {refreshError}
            </p>
          )}
        </>
      )}

      <div className="divide-y divide-border overflow-hidden rounded-8 border border-border bg-surface">
        {visibleProviders.map((provider) => {
          const status = toolStatus[provider.statusKey];
          const isLoggedIn = status?.loggedIn === true;
          // Revoked credentials read as a distinct "needs re-login" badge (and
          // still offer the sign-in buttons, since loggedIn is false).
          const needsReauth = status?.needsReauth === true;
          const providerName = t(`aiTools.providers.${provider.i18nKey}.name` as const);
          const accountType = formatAccountType(status?.accountType);
          const usesManagedApiKey =
            provider.id === "claude-login" &&
            (status?.authMethod === "stored-compatible" ||
              configuredAnthropicProvider?.hasApiKey === true);
          const usesEnvironmentApiKey =
            provider.id === "claude-login" && status?.authMethod === "environment";
          const usesApiKey = usesManagedApiKey || usesEnvironmentApiKey;
          const apiKeyProviderName =
            configuredAnthropicProvider?.provider === CUSTOM_ANTHROPIC_PROVIDER_ID
              ? t("aiTools.otherProviders.custom.providerName")
              : (configuredAnthropicProvider?.providerName ?? accountType ?? providerName);

          const shouldShowUsage =
            !usesApiKey && shouldShowAiToolUsage(showUsage, status, provider.available);
          return (
            <div key={provider.id} className="px-4 py-2">
              <div className="flex items-center gap-2">
                <AiToolIcon icon={provider.icon} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-ui text-foreground">{providerName}</p>
                    {provider.available && !loadingStatus && (
                      <span
                        className={`inline-flex items-center gap-1 text-aux ${
                          isLoggedIn
                            ? "text-success-fg"
                            : needsReauth
                              ? "text-warning-fg"
                              : "text-muted-foreground"
                        }`}
                      >
                        <span
                          className={`size-1.5 rounded-full ${
                            isLoggedIn
                              ? "bg-success"
                              : needsReauth
                                ? "bg-warning"
                                : "bg-muted-foreground/50"
                          }`}
                        />
                        {isLoggedIn
                          ? usesApiKey
                            ? t("aiTools.status.apiKeyActive")
                            : t("aiTools.status.connected")
                          : needsReauth
                            ? usesApiKey
                              ? t("aiTools.status.apiKeyNeedsUpdate")
                              : t("aiTools.status.needsReauth")
                            : t("aiTools.status.notConnected")}
                      </span>
                    )}
                    {!provider.available && (
                      <span className="text-aux text-muted-foreground">
                        {t("aiTools.status.comingSoon")}
                      </span>
                    )}
                  </div>
                  {usesApiKey ? (
                    usesManagedApiKey && configuredAnthropicProvider ? (
                      <p className="flex items-center gap-2 text-aux text-muted-foreground">
                        <AnthropicCompatibleProviderLogo
                          providerId={configuredAnthropicProvider.provider}
                        />
                        <span className="text-foreground">{apiKeyProviderName}</span>
                      </p>
                    ) : (
                      <p className="text-aux text-muted-foreground">
                        {t("aiTools.authSource.environmentApiKey")}
                      </p>
                    )
                  ) : isLoggedIn ? (
                    <p className="truncate text-aux text-muted-foreground">
                      {status.authMethod ? (
                        <>
                          <span className="hidden sm:inline">
                            <Trans
                              i18nKey="aiTools.status.signedInWith"
                              t={t}
                              values={{ method: status.authMethod }}
                              components={{
                                1: <span className="text-foreground" />,
                              }}
                            />
                          </span>
                          <span className="sm:hidden">{status.authMethod}</span>
                          {accountType && (
                            <>
                              <span className="mx-2">·</span>
                              <span className="hidden sm:inline">
                                <Trans
                                  i18nKey="aiTools.status.accountType"
                                  t={t}
                                  values={{ type: accountType }}
                                  components={{
                                    1: <span className="text-foreground" />,
                                  }}
                                />
                              </span>
                              <span className="sm:hidden">{accountType}</span>
                            </>
                          )}
                        </>
                      ) : (
                        t("aiTools.status.signedIn")
                      )}
                    </p>
                  ) : null}
                </div>
                {provider.available && (
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {provider.id === "claude-login" &&
                    usesManagedApiKey &&
                    configuredAnthropicProvider ? (
                      <ButtonGroup>
                        <Button
                          variant="outline"
                          size="sm"
                          className={AI_TOOL_ACTION_BUTTON_CLASS}
                          onClick={openAnthropicProviderDialog}
                        >
                          {t("aiTools.otherProviders.changeProvider")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRemoveAnthropicProviderOpen(true)}
                          disabled={savingAnthropicProvider}
                          className={`${AI_TOOL_ACTION_BUTTON_CLASS} text-destructive hover:bg-destructive/10 hover:text-destructive`}
                        >
                          {t("common.remove")}
                        </Button>
                      </ButtonGroup>
                    ) : provider.id === "claude-login" && !usesApiKey && !isLoggedIn ? (
                      <ButtonGroup>
                        <Button
                          variant="outline"
                          size="sm"
                          className={AI_TOOL_ACTION_BUTTON_CLASS}
                          onClick={() => setTerminalPreset(provider.id)}
                        >
                          {t("aiTools.logIn")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className={AI_TOOL_ACTION_BUTTON_CLASS}
                          title={t("aiTools.otherProviders.apiProvidersTooltip")}
                          onClick={openAnthropicProviderDialog}
                        >
                          {t("aiTools.otherProviders.apiKey")}
                        </Button>
                      </ButtonGroup>
                    ) : (
                      <>
                        {provider.id === "claude-login" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className={AI_TOOL_ACTION_BUTTON_CLASS}
                            title={t("aiTools.otherProviders.apiProvidersTooltip")}
                            onClick={openAnthropicProviderDialog}
                          >
                            {t("aiTools.otherProviders.apiKey")}
                          </Button>
                        )}
                        {!usesApiKey &&
                          (isLoggedIn ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={logoutProvider === provider.statusKey && logoutPending}
                              aria-label={
                                logoutProvider === provider.statusKey && logoutPending
                                  ? t("aiTools.loggingOut")
                                  : undefined
                              }
                              onClick={() => {
                                setLogoutError(null);
                                setLogoutProvider(
                                  provider.id === "codex-login" ? "codex" : "claude",
                                );
                              }}
                              className={`${AI_TOOL_ACTION_BUTTON_CLASS} shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive`}
                            >
                              {logoutProvider === provider.statusKey && logoutPending ? (
                                <>
                                  <Spinner size="sm" label={t("aiTools.loggingOut")} />
                                  <span aria-hidden>{t("aiTools.loggingOut")}</span>
                                </>
                              ) : (
                                t("aiTools.logOut")
                              )}
                            </Button>
                          ) : (
                            <AiToolSignInButtons
                              methods={getSignInMethods(provider.id, t, {
                                openChatgptModal: () => setChatgptModalOpen(true),
                                openDeviceLogin: () => setDeviceLoginModalOpen(true),
                                openTerminal: (preset) => setTerminalPreset(preset),
                              })}
                            />
                          ))}
                      </>
                    )}
                  </div>
                )}
              </div>

              {shouldShowUsage && (
                <>
                  <div className="my-3 border-t border-border" />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1px_1fr] sm:gap-4">
                    <UsageBar
                      label={t("aiTools.usage.fiveHour")}
                      window={status.usage?.fiveHour}
                      windowKey="fiveHour"
                      resetsInLabel="settings:aiTools.usage.resetsIn"
                    />
                    <div className="hidden bg-border sm:block" aria-hidden />
                    <UsageBar
                      label={t("aiTools.usage.sevenDay")}
                      window={status.usage?.sevenDay}
                      windowKey="sevenDay"
                      resetsInLabel="settings:aiTools.usage.resetsIn"
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <Dialog
        open={anthropicProviderDialogOpen}
        onClose={closeAnthropicProviderDialog}
        ariaLabel={t("aiTools.otherProviders.title")}
        size="lg"
      >
        <DialogHeader onClose={closeAnthropicProviderDialog} closeLabel={t("common.cancel")}>
          <div className="flex items-center gap-2">
            <DialogTitle>{t("aiTools.otherProviders.title")}</DialogTitle>
            <span className="text-aux text-warning-fg">
              {t("aiTools.otherProviders.experimental")}
            </span>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <DialogDescription>{t("aiTools.otherProviders.dialogDescription")}</DialogDescription>
          <div
            className={
              selectedProvider?.kind === "custom"
                ? "max-w-xs"
                : "grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]"
            }
          >
            <Field>
              <FieldLabel htmlFor={`${uid}-anthropic-provider`}>
                {t("aiTools.otherProviders.providerLabel")}
              </FieldLabel>
              <Select
                value={selectedAnthropicProvider}
                onValueChange={handleAnthropicProviderChange}
              >
                <SelectTrigger id={`${uid}-anthropic-provider`} className="w-full">
                  <SelectValue placeholder={t("aiTools.otherProviders.providerPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {anthropicProviders.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      <span className="flex items-center gap-2">
                        <AnthropicCompatibleProviderLogo providerId={provider.id} />
                        <span>
                          {provider.id === CUSTOM_ANTHROPIC_PROVIDER_ID
                            ? t("aiTools.otherProviders.custom.providerName")
                            : provider.name}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {selectedProvider?.kind !== "custom" && (
              <Field>
                <FieldLabel htmlFor={`${uid}-anthropic-api-key`}>
                  {t("aiTools.otherProviders.apiKeyLabel")}
                </FieldLabel>
                <Input
                  id={`${uid}-anthropic-api-key`}
                  type="password"
                  value={anthropicApiKey}
                  onChange={(event) => setAnthropicApiKey(event.target.value)}
                  placeholder={
                    configuredAnthropicProvider?.hasApiKey
                      ? t("aiTools.otherProviders.apiKeyPlaceholderReplace")
                      : t("aiTools.otherProviders.apiKeyPlaceholderNew")
                  }
                  className="w-full"
                />
              </Field>
            )}
          </div>
          {selectedProvider?.kind === "preset" &&
            selectedProvider.apiKeyEnvVar &&
            selectedProvider.baseUrl && (
              <p className="text-aux text-muted-foreground">
                {t("aiTools.otherProviders.envHint", {
                  envVar: selectedProvider.apiKeyEnvVar,
                  baseUrl: selectedProvider.baseUrl,
                })}
              </p>
            )}
          {selectedProvider?.kind === "custom" && (
            <div className="space-y-3 rounded-12 border border-border bg-muted/20 p-3">
              <p className="text-ui text-foreground">{t("aiTools.otherProviders.custom.title")}</p>
              <SegmentedControl
                aria-label={t("aiTools.otherProviders.custom.inputModeLabel")}
                size="sm"
                value={anthropicEnvEditorMode}
                onValueChange={handleAnthropicEnvEditorModeChange}
                options={[
                  { value: "json", label: t("aiTools.otherProviders.custom.jsonMode") },
                  { value: "fields", label: t("aiTools.otherProviders.custom.fieldsMode") },
                ]}
              />
              {anthropicEnvEditorMode === "json" ? (
                <Textarea
                  aria-label={t("aiTools.otherProviders.custom.jsonLabel")}
                  value={anthropicEnvJson}
                  onChange={(event) => handleAnthropicEnvJsonChange(event.target.value)}
                  placeholder={t("aiTools.otherProviders.custom.jsonPlaceholder")}
                  spellCheck={false}
                  className="min-h-64 resize-y font-mono text-aux"
                  aria-invalid={anthropicEnvError ? true : undefined}
                />
              ) : (
                <div className="space-y-2">
                  {anthropicEnvEntries.length === 0 ? (
                    <EmptyState className="rounded-8 border border-dashed border-border">
                      <EmptyStateTitle>
                        {t("aiTools.otherProviders.custom.emptyFields")}
                      </EmptyStateTitle>
                    </EmptyState>
                  ) : (
                    anthropicEnvEntries.map((entry, index) => (
                      <div
                        key={entry.id}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_auto]"
                      >
                        <Input
                          aria-label={t("aiTools.otherProviders.custom.keyAriaLabel", {
                            index: index + 1,
                          })}
                          value={entry.key}
                          onChange={(event) =>
                            updateAnthropicEnvEntry(entry.id, "key", event.target.value)
                          }
                          placeholder={t("aiTools.otherProviders.custom.keyPlaceholder")}
                          className="font-mono text-aux max-sm:col-span-2"
                        />
                        <Input
                          aria-label={t("aiTools.otherProviders.custom.valueAriaLabel", {
                            index: index + 1,
                          })}
                          type="text"
                          value={entry.value}
                          onChange={(event) =>
                            updateAnthropicEnvEntry(entry.id, "value", event.target.value)
                          }
                          placeholder={t("aiTools.otherProviders.custom.valuePlaceholder")}
                          className="font-mono text-aux"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-md"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={t("aiTools.otherProviders.custom.removeVariable", {
                            key: entry.key || index + 1,
                          })}
                          onClick={() => {
                            setAnthropicEnvEntries((entries) =>
                              entries.filter((candidate) => candidate.id !== entry.id),
                            );
                            setAnthropicEnvError(null);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAnthropicEnvEntries((entries) => [...entries, createAnthropicEnvEntry()]);
                      setAnthropicEnvError(null);
                    }}
                  >
                    <Plus />
                    {t("aiTools.otherProviders.custom.addVariable")}
                  </Button>
                </div>
              )}
              {anthropicEnvError && (
                <p role="alert" className="text-aux text-destructive">
                  {t(
                    `aiTools.otherProviders.custom.errors.${anthropicEnvError}` as
                      | "aiTools.otherProviders.custom.errors.invalidJson"
                      | "aiTools.otherProviders.custom.errors.envMustBeObject"
                      | "aiTools.otherProviders.custom.errors.valuesMustBeStrings"
                      | "aiTools.otherProviders.custom.errors.emptyKey"
                      | "aiTools.otherProviders.custom.errors.emptyValue"
                      | "aiTools.otherProviders.custom.errors.duplicateKey"
                      | "aiTools.otherProviders.custom.errors.emptyEnv",
                  )}
                </p>
              )}
              <p className="text-aux text-muted-foreground">
                {t("aiTools.otherProviders.custom.securityHint")}
              </p>
            </div>
          )}
          {configuredAnthropicProvider?.needsReauth && (
            <p className="text-ui text-warning-fg">
              {t("aiTools.otherProviders.needsApiKeyUpdate", {
                providerName: configuredAnthropicProvider.providerName,
              })}
            </p>
          )}
          {anthropicProviderMessage && (
            <p role="alert" className="text-ui text-destructive">
              {anthropicProviderMessage}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={closeAnthropicProviderDialog}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void saveAnthropicProviderCredentials()}
            disabled={
              !selectedAnthropicProvider ||
              (selectedProvider?.kind !== "custom" && !anthropicApiKey.trim()) ||
              savingAnthropicProvider
            }
          >
            {selectedProvider?.kind === "custom"
              ? t("aiTools.otherProviders.saveConfiguration")
              : t("aiTools.otherProviders.saveKey")}
          </Button>
        </DialogFooter>
      </Dialog>

      {terminalPreset && (
        <Suspense fallback={null}>
          <TerminalModal preset={terminalPreset} onClose={handleTerminalClose} />
        </Suspense>
      )}

      {chatgptModalOpen && (
        <Suspense fallback={null}>
          <ChatGPTLoginModal
            open={chatgptModalOpen}
            onClose={() => {
              setChatgptModalOpen(false);
              void fetchStatus();
            }}
            onConnected={() => {
              setChatgptModalOpen(false);
              void fetchStatus();
            }}
          />
        </Suspense>
      )}

      {deviceLoginModalOpen && (
        <Suspense fallback={null}>
          <CodexDeviceLoginModal
            open={deviceLoginModalOpen}
            onClose={() => {
              setDeviceLoginModalOpen(false);
              void fetchStatus();
            }}
            onConnected={() => {
              setDeviceLoginModalOpen(false);
              void fetchStatus();
            }}
          />
        </Suspense>
      )}

      {logoutConfig && (
        <RomeConfirmDialog
          open
          icon={logoutConfig.icon}
          title={t(logoutConfig.titleKey)}
          description={logoutError ?? t(logoutConfig.descriptionKey)}
          confirmLabel={t("aiTools.logOut")}
          destructive
          confirmDisabled={logoutPending}
          onConfirm={() => void handleLogout()}
          onCancel={() => setLogoutProvider(null)}
        />
      )}

      {configuredAnthropicProvider && (
        <RomeConfirmDialog
          open={removeAnthropicProviderOpen}
          title={t("aiTools.otherProviders.removeConfirm.title", {
            providerName: configuredAnthropicProvider.providerName,
          })}
          description={t("aiTools.otherProviders.removeConfirm.description", {
            providerName: configuredAnthropicProvider.providerName,
          })}
          confirmLabel={t("common.remove")}
          destructive
          confirmDisabled={savingAnthropicProvider}
          onConfirm={() => void clearAnthropicProviderCredentials()}
          onCancel={() => setRemoveAnthropicProviderOpen(false)}
        />
      )}
    </div>
  );
}
