import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { AppAccessPanel } from "@/components/app-access-panel";
import { RomeAppHost } from "@/components/rome-app-host";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useTheme } from "@/hooks/use-theme";
import { getActiveLocale } from "@/i18n";

interface AppManifestResponse {
  appId: string;
  appName: string;
  entryUrl: string;
  styleUrls: string[];
  accessMode?: "private" | "public" | "cloud-email";
  callerAccessAllowed?: boolean;
  bootstrap: {
    appId: string;
    version: string;
    routeBase: string;
    routePath: string;
    apiBase: string;
    assetBase: string;
    shell: { theme: "light" | "dark"; themeName: string; mode: "embedded" | "full" };
    caller?:
      | { kind: "guardian"; userId: string; email?: string }
      | { kind: "visitor"; accountId: string; email: string }
      | { kind: "anonymous" };
    globalParams?: Record<string, never>;
  };
}

export default function AppFullPage() {
  const { t } = useTranslation("apps");
  const { resolved: theme, theme: themeName } = useTheme();
  const params = useParams<{ appId: string; "*"?: string }>();
  const appId = params.appId;
  const splat = params["*"] ?? "";
  const [manifest, setManifest] = useState<AppManifestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    const query = new URLSearchParams({ mode: "full", path: splat });
    fetch(`/api/apps/${encodeURIComponent(appId)}/manifest?${query}`, {
      credentials: "include",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || t("full.errors.loadFailed"));
        }
        return (await response.json()) as AppManifestResponse;
      })
      .then((data) => {
        if (!cancelled) setManifest(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [appId, splat, t]);

  if (error) {
    return (
      <main className="min-h-dvh bg-background pb-safe pt-safe">
        <div className="p-8">
          <Alert variant="destructive" className="mx-auto max-w-xl rounded-16 p-6">
            <AlertTitle className="text-title">{t("full.failedTitle")}</AlertTitle>
            <AlertDescription className="mt-2">{error}</AlertDescription>
          </Alert>
        </div>
      </main>
    );
  }

  if (!manifest) return null;

  if (manifest.accessMode === "cloud-email" && manifest.callerAccessAllowed !== true) {
    return (
      <main className="flex min-h-dvh items-center bg-background pb-safe pt-safe">
        <div className="w-full p-8">
          <AppAccessPanel
            appId={manifest.appId}
            appName={manifest.appName}
            visitorEmail={
              manifest.bootstrap.caller?.kind === "visitor" ? manifest.bootstrap.caller.email : null
            }
          />
        </div>
      </main>
    );
  }

  const bootstrap = {
    ...manifest.bootstrap,
    shell: {
      ...manifest.bootstrap.shell,
      theme,
      themeName,
      locale: getActiveLocale(),
    },
  };

  return (
    <main className="min-h-dvh bg-background pb-safe pt-safe">
      <RomeAppHost
        appId={manifest.appId}
        appName={manifest.appName}
        entryUrl={manifest.entryUrl}
        styleUrls={manifest.styleUrls}
        bootstrap={bootstrap}
      />
    </main>
  );
}
