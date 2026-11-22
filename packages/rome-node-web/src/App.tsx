import { useCallback, useEffect, useState } from "react";
import {
  Languages,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  ScrollText,
  Sun,
} from "lucide-react";
import { Alert, AlertDescription } from "@rome-os/ui/alert";
import { Badge } from "@rome-os/ui/badge";
import { Button } from "@rome-os/ui/button";
import { cn } from "@rome-os/ui/cn";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@rome-os/ui/empty-state";
import { IconButton } from "@rome-os/ui/icon-button";
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@rome-os/ui/page";
import { Spinner } from "@rome-os/ui/spinner";
import { UiScaleProvider } from "@rome-os/ui/ui-scale";
import { ApiError, api, subscribeEvents } from "./api";
import { AuditLogView } from "./components/AuditLogView";
import { LoginView } from "./components/LoginView";
import { OverviewView, phaseBadgeVariant } from "./components/OverviewView";
import { RomeLogo } from "./components/RomeLogo";
import { initialLocale, messages, saveLocale, type Locale } from "./i18n";
import {
  applyThemePreference,
  nextThemePreference,
  readThemePreference,
  type ThemePreference,
} from "./theme";
import type { AuthSession, HostSnapshot } from "./types";

type ActiveTab = "overview" | "log";

function readTabFromLocation(): ActiveTab {
  if (typeof window === "undefined") return "overview";
  const path = window.location.pathname;
  return path === "/log" || path.startsWith("/log/") ? "log" : "overview";
}

function ThemeIcon({ pref }: { pref: ThemePreference }) {
  if (pref === "light") return <Sun />;
  if (pref === "dark") return <Moon />;
  return <Monitor />;
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => initialLocale());
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => readTabFromLocation());
  const [session, setSession] = useState<AuthSession | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [logRefreshSignal, setLogRefreshSignal] = useState(0);

  const t = messages[locale];

  useEffect(() => {
    const onPopState = () => setActiveTab(readTabFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigateTab = useCallback((next: ActiveTab) => {
    setActiveTab(next);
    const targetPath = next === "log" ? "/log" : "/";
    if (typeof window !== "undefined" && window.location.pathname !== targetPath) {
      window.history.pushState(null, "", targetPath);
    }
  }, []);

  useEffect(() => {
    applyThemePreference(theme);
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyThemePreference("system");
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, [theme]);

  const handleUnauthorized = useCallback(() => {
    setSession((prev) => ({
      authRequired: true,
      authenticated: false,
      passwordSource: prev?.passwordSource ?? "file",
    }));
    setSnapshot(null);
  }, []);

  const loadStatus = useCallback(async () => {
    setRefreshing(true);
    setLoadError(null);
    try {
      const next = await api.status();
      setSnapshot(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        handleUnauthorized();
      } else {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRefreshing(false);
    }
  }, [handleUnauthorized]);

  const bootstrap = useCallback(async () => {
    setLoadError(null);
    try {
      const nextSession = await api.session();
      setSession(nextSession);
      if (nextSession.authenticated) {
        await loadStatus();
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [loadStatus]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!session?.authenticated) return;
    return subscribeEvents({
      onStatus: (next) => {
        setSnapshot(next);
      },
    });
  }, [session?.authenticated]);

  function handleToggleLocale() {
    const next: Locale = locale === "en" ? "zh-CN" : "en";
    setLocale(next);
    saveLocale(next);
  }

  function handleCycleTheme() {
    setTheme((current) => nextThemePreference(current));
  }

  function handleRefresh() {
    void loadStatus();
    if (activeTab === "log") {
      setLogRefreshSignal((n) => n + 1);
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      handleUnauthorized();
    }
  }

  const themeLabel =
    theme === "system"
      ? t.header.themeLight
      : theme === "light"
        ? t.header.themeDark
        : t.header.themeSystem;

  return (
    <UiScaleProvider>
      {session && session.authRequired && !session.authenticated ? (
        <LoginView
          t={t}
          passwordSource={session.passwordSource}
          themeIcon={<ThemeIcon pref={theme} />}
          themeLabel={themeLabel}
          onCycleTheme={handleCycleTheme}
          onToggleLocale={handleToggleLocale}
          onUnlocked={(nextSession) => {
            setSession(nextSession);
            void loadStatus();
          }}
        />
      ) : (
        <main className="min-h-screen bg-background text-foreground">
          <div className="mx-auto w-full max-w-6xl">
            <Page>
              <PageHeader>
                <PageHeading>
                  <div className="flex flex-wrap items-center gap-3">
                    <RomeLogo className="size-7 text-foreground" />
                    <PageTitle>{t.brandName}</PageTitle>
                    {snapshot ? (
                      <Badge variant={phaseBadgeVariant(snapshot.phase)}>
                        {t.phase[snapshot.phase]}
                      </Badge>
                    ) : null}
                  </div>
                  <PageDescription>{t.appSubtitle}</PageDescription>
                </PageHeading>
                <PageActions>
                  <IconButton
                    label={t.header.refresh}
                    size="sm"
                    disabled={refreshing}
                    onClick={handleRefresh}
                    icon={<RefreshCw className={refreshing ? "animate-spin" : undefined} />}
                  />
                  <IconButton
                    label={themeLabel}
                    size="sm"
                    onClick={handleCycleTheme}
                    icon={<ThemeIcon pref={theme} />}
                  />
                  <IconButton
                    label={t.header.switchLanguage}
                    size="sm"
                    onClick={handleToggleLocale}
                    icon={<Languages />}
                  />
                  {session?.authRequired ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleLogout()}
                    >
                      <LogOut data-icon="inline-start" />
                      {t.header.signOut}
                    </Button>
                  ) : null}
                </PageActions>
              </PageHeader>

              {snapshot ? (
                <div
                  role="tablist"
                  aria-label={t.nav.label}
                  className="inline-flex w-fit items-center gap-1 rounded-12 border border-border-subtle bg-surface-muted p-1"
                >
                  {(
                    [
                      { id: "overview", label: t.nav.overview, icon: LayoutDashboard },
                      { id: "log", label: t.nav.log, icon: ScrollText },
                    ] as const
                  ).map(({ id, label, icon: Icon }) => {
                    const active = activeTab === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => navigateTab(id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-8 px-3 py-1.5 text-ui font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Icon className="size-3.5" aria-hidden />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {loadError ? (
                <Alert variant="destructive">
                  <AlertDescription>{loadError}</AlertDescription>
                </Alert>
              ) : null}

              {!snapshot ? (
                <EmptyState>
                  <EmptyStateIcon>
                    <Spinner />
                  </EmptyStateIcon>
                  <EmptyStateTitle>{t.loading}</EmptyStateTitle>
                </EmptyState>
              ) : activeTab === "log" ? (
                <AuditLogView
                  locale={locale}
                  t={t}
                  snapshot={snapshot}
                  refreshSignal={logRefreshSignal}
                  onUnauthorized={handleUnauthorized}
                />
              ) : (
                <OverviewView
                  t={t}
                  snapshot={snapshot}
                  onSnapshot={setSnapshot}
                  passwordSource={session?.passwordSource ?? "none"}
                  canRemovePassword={session?.canRemovePassword ?? false}
                  onSessionChange={setSession}
                  onOpenLog={() => navigateTab("log")}
                />
              )}
            </Page>
          </div>
        </main>
      )}
    </UiScaleProvider>
  );
}
