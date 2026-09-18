import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { AppAccessPanel } from "@/components/app-access-panel";
import { AppActionsFab } from "@/components/app-actions-fab";
import { RomeAppHost } from "@/components/rome-app-host";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAppCatalogEvents } from "@/hooks/use-app-catalog-events";
import { useTheme } from "@/hooks/use-theme";
import { getActiveLocale } from "@/i18n";
import { fetchJson } from "@/lib/fetch-json";
import { PageShell } from "@/shell/PageShell";

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
    shell: {
      theme: "light" | "dark";
      themeName: string;
      mode: "embedded" | "full";
    };
    caller?:
      | { kind: "guardian"; userId: string; email?: string }
      | { kind: "visitor"; accountId: string; email: string }
      | { kind: "anonymous" };
    globalParams?: Record<string, never>;
  };
}

function useAppManifest(appId: string | undefined, path: string, mode: "embedded" | "full") {
  const { t } = useTranslation("apps");

  // react-query owns the fetch lifecycle here. A single reinstall can fire
  // several catalog-change events in quick succession (the reconciler refreshes
  // the catalog at multiple phases), each poking a `refetch`. Because `refetch`
  // defaults to `cancelRefetch: true`, a newer poke aborts the in-flight request
  // (via the queryFn's `signal`) and only the latest response updates the cache
  // — an earlier request whose response merely arrives out of order can never
  // clobber fresher state. `staleTime: Infinity` + no focus refetch keeps this
  // lifecycle-driven: the catalog stream is the only thing that re-fetches.
  const query = useQuery({
    queryKey: ["app-manifest", appId, path, mode] as const,
    enabled: Boolean(appId),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ mode, path });
      return fetchJson<AppManifestResponse>(
        `/api/apps/${encodeURIComponent(appId as string)}/manifest?${params}`,
        { signal, fallback: t("embedded.errors.loadFailed") },
      );
    },
  });

  // react-query retains the last successful `data` across an error, so the
  // manifest — and thus the guardian check that keeps the stream open — survives
  // an uninstall-while-open; `isError` drives the panel and clears on a
  // successful recovery refetch.
  return {
    manifest: query.data ?? null,
    error: query.isError ? (query.error as Error).message : null,
    refetch: query.refetch,
  };
}

export default function AppEmbeddedPage() {
  const { t } = useTranslation("apps");
  const { resolved: theme, theme: themeName } = useTheme();
  const { appId } = useParams<{ appId: string; "*"?: string }>();
  const params = useParams<{ "*"?: string }>();
  const splat = params["*"] ?? "";
  const { manifest, error, refetch } = useAppManifest(appId, splat, "embedded");

  // Guardian-only live refresh (#1640): open the catalog-change stream only
  // when the loaded manifest reports the caller as a guardian, so visitor and
  // anonymous embedded views never open a connection the backend would reject.
  // The manifest stays authoritative; the stream is only a poke to refetch it.
  const isGuardian = manifest?.bootstrap.caller?.kind === "guardian";
  useAppCatalogEvents(appId, isGuardian, refetch);

  // Remount gate (#1640): RomeAppHost keys its mount lifecycle on `entryUrl`
  // (a string, value-compared) and `styleUrls` (an array, reference-compared).
  // Stabilize the styleUrls reference so a refetch that returns the same list —
  // a backend-only reinstall, a byte-identical rebuild, or a catch-up refetch
  // after a stream blip — hands the host an identical reference and does not
  // remount. Key the memo on the list's own content (not `entryUrl`) so a
  // stylesheet change is caught on its own terms: correctness doesn't depend on
  // the invariant that the JS entry hash also covers CSS.
  const styleUrlsKey = (manifest?.styleUrls ?? []).join("\n");
  const styleUrls = useMemo(() => manifest?.styleUrls ?? [], [styleUrlsKey]);

  if (error) {
    return (
      <PageShell>
        <Alert variant="destructive" className="rounded-16 p-6">
          <AlertTitle className="text-title">{t("embedded.failedTitle")}</AlertTitle>
          <AlertDescription className="mt-2">{error}</AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  if (!manifest) return null;

  if (manifest.accessMode === "cloud-email" && manifest.callerAccessAllowed !== true) {
    return (
      <PageShell>
        <AppAccessPanel
          appId={manifest.appId}
          appName={manifest.appName}
          visitorEmail={
            manifest.bootstrap.caller?.kind === "visitor" ? manifest.bootstrap.caller.email : null
          }
        />
      </PageShell>
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

  // Plain div: RomeShellLayout owns the `main` landmark for every shell route.
  // The floating actions widget is guardian-only host chrome; visitors and
  // anonymous callers get the bare app. The full view (`/full/apps/:appId`)
  // renders through AppFullPage and never mounts it — that surface is
  // user-facing.
  return (
    <div>
      <RomeAppHost
        appId={manifest.appId}
        appName={manifest.appName}
        entryUrl={manifest.entryUrl}
        styleUrls={styleUrls}
        bootstrap={bootstrap}
      />
      {isGuardian ? <AppActionsFab appId={manifest.appId} /> : null}
    </div>
  );
}
