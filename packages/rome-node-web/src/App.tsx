import { useCallback, useEffect, useState } from "react";
import { Languages, LogOut, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { Alert, AlertDescription } from "@rome-os/ui/alert";
import { Badge } from "@rome-os/ui/badge";
import { Button } from "@rome-os/ui/button";
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

function ThemeIcon({ pref }: { pref: ThemePreference }) {
  if (pref === "light") return <Sun />;
  if (pref === "dark") return <Moon />;
  return <Monitor />;
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => initialLocale());
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const [session, setSession] = useState<AuthSession | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const t = messages[locale];

  useEffect(() => {
    applyThemePreference(theme);
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyThemePreference("system");
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, [theme]);

  const loadStatus = useCallback(async () => {
    setRefreshing(true);
    setLoadError(null);
    try {
      const next = await api.status();
      setSnapshot(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession((prev) => ({
          authRequired: true,
          authenticated: false,
          passwordSource: prev?.passwordSource ?? "file",
        }));
        setSnapshot(null);
      } else {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

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

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      setSession((prev) => ({
        authRequired: true,
        authenticated: false,
        passwordSource: prev?.passwordSource ?? "file",
      }));
      setSnapshot(null);
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
          <div className="mx-auto w-full max-w-5xl">
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
                    onClick={() => void loadStatus()}
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
              ) : (
                <OverviewView
                  t={t}
                  snapshot={snapshot}
                  onSnapshot={setSnapshot}
                  passwordSource={session?.passwordSource ?? "none"}
                  canRemovePassword={session?.canRemovePassword ?? false}
                  onSessionChange={setSession}
                />
              )}
            </Page>
          </div>
        </main>
      )}
    </UiScaleProvider>
  );
}
