import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Spinner } from "@rome-os/ui/spinner";
import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateAction, EmptyStateTitle } from "@/components/ui/empty-state";
import { getApiErrorMessage } from "@/lib/api-error";

export interface ListingDetail {
  id: string;
  handle: string;
  slug: string;
  name: string | null;
  description: string | null;
  longDescription: string | null;
  /** Absolute icon URL persisted by the store (S3 object or the store's default icon). */
  iconUrl: string | null;
  /** @deprecated The store API never emitted this; kept so older callers still typecheck. */
  iconPath?: string | null;
  categories: string[];
  state: "published" | "taken_down" | "deleted";
  highestVersion: string;
  verified: boolean;
}

export interface VersionRow {
  version: string;
  contentHash: string;
  sizeBytes: number;
  state: "live" | "revoked";
  publishedAt: string;
  sourceAvailable?: boolean;
}

export interface ListingDetailPayload {
  available: boolean;
  reason?: string;
  error?: string;
  browseOrigin?: string | null;
  listing?: ListingDetail;
  versions?: VersionRow[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function resolveIconUrl(
  browseOrigin: string | null | undefined,
  iconPath: string | null,
): string | null {
  if (!iconPath) return null;
  if (/^https?:\/\//i.test(iconPath)) return iconPath;
  if (!browseOrigin) return null;
  try {
    const resolved = new URL(iconPath, browseOrigin);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

export interface AppInstallConfirmProps {
  /** Listing id — bare handle (`xiaohongshu`) or scoped (`@handle/slug`). */
  listingId: string;
  /** Pinned version from the install link, or null to take the latest live one. */
  requestedVersion: string | null;
  /** Called after a successful install (success toast already fired). */
  onInstalled: (name: string) => void;
  /** Called when the user dismisses the flow without installing. */
  onCancel: () => void;
}

/**
 * Fetches a store listing, shows its install details, and installs it on
 * confirmation. Shared by the full-page `/install-app/*` route and the App
 * Store sheet's confirm dialog.
 */
export function AppInstallConfirm({
  listingId,
  requestedVersion,
  onInstalled,
  onCancel,
}: AppInstallConfirmProps) {
  const { t } = useTranslation("apps");

  const scoped = listingId.startsWith("@");
  const apiPath = useMemo(() => {
    if (scoped) {
      const [handle, slug] = listingId.split("/");
      return `/api/app-store/listings/${encodeURIComponent(handle)}/${encodeURIComponent(slug ?? "")}`;
    }
    return `/api/app-store/listings/${encodeURIComponent(listingId)}`;
  }, [listingId, scoped]);

  const [data, setData] = useState<ListingDetailPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(apiPath, { credentials: "include", cache: "no-store" });
      if (response.status === 404 || response.status === 410) {
        setLoadError(t("install.errors.notFound"));
        setData(null);
        return;
      }
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, t("install.errors.loadFailed")));
      }
      const payload = (await response.json()) as ListingDetailPayload;
      setData(payload);
      if (payload.error) setLoadError(payload.error);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("install.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiPath, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pick the requested version when present and live; otherwise the latest live
  // version. Falls back to the listing's highestVersion if no rows surface.
  const target = useMemo(() => {
    const versions = (data?.versions ?? []).filter((v) => v.state === "live");
    if (versions.length === 0) return null;
    if (requestedVersion) {
      const match = versions.find((v) => v.version === requestedVersion);
      if (match) return match;
    }
    return versions[0];
  }, [data, requestedVersion]);

  const handleInstall = useCallback(async () => {
    if (!target || installing) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const response = await fetch("/api/apps", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            mode: "appstore",
            listingId,
            version: target.version,
            contentHash: target.contentHash,
          },
        }),
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, t("install.errors.installFailed")));
      }
      onInstalled(data?.listing?.name ?? listingId);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : t("install.errors.installFailed"));
    } finally {
      setInstalling(false);
    }
  }, [target, installing, listingId, data, onInstalled, t]);

  const browseOrigin = data?.browseOrigin ?? null;
  const listing = data?.listing ?? null;
  const iconUrl = listing
    ? resolveIconUrl(browseOrigin, listing.iconUrl ?? listing.iconPath ?? null)
    : null;
  const displayName = listing?.name ?? listing?.id ?? listingId;

  if (loading) {
    return <p className="text-ui text-muted-foreground">{t("install.loading")}</p>;
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-3 rounded-12 bg-destructive-bg px-4 py-4 text-ui text-destructive-fg">
        <span>{loadError}</span>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => void refresh()}>
            {t("listing.retry")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {t("install.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (data?.available === false) {
    return (
      <EmptyState className="rounded-12 border border-dashed border-border bg-surface/50">
        <EmptyStateTitle>{data.reason ?? t("install.unavailable")}</EmptyStateTitle>
        <EmptyStateAction>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {t("install.cancel")}
          </Button>
        </EmptyStateAction>
      </EmptyState>
    );
  }

  if (!listing) return null;

  if (!target) {
    return (
      <div className="flex flex-col gap-4">
        <header className="flex items-center gap-3">
          <AppIcon displayName={displayName} iconUrl={iconUrl} />
          <h1 className="text-title text-foreground">{displayName}</h1>
        </header>
        <p className="rounded-12 border border-dashed border-border bg-surface px-4 py-3 text-ui text-muted-foreground">
          {t("install.noLiveVersion")}
        </p>
        <Button type="button" variant="outline" onClick={onCancel} className="self-start">
          {t("install.cancel")}
        </Button>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6 rounded-12 border border-border bg-surface p-6">
      <header className="flex items-start gap-3">
        <AppIcon displayName={displayName} iconUrl={iconUrl} />
        <div className="min-w-0 flex-1">
          <h1 className="text-title text-foreground">{t("install.title")}</h1>
          <p className="mt-1 text-ui text-muted-foreground">
            <Trans
              i18nKey="install.subtitle"
              t={t}
              values={{ name: displayName }}
              components={{ strong: <strong className="text-foreground" /> }}
            />
          </p>
        </div>
      </header>

      {listing.description ? (
        <p className="text-aux text-foreground">{listing.description}</p>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-aux">
        <dt className="text-subtle-foreground">{t("install.version")}</dt>
        <dd className="font-mono tabular-nums text-foreground">v{target.version}</dd>
        <dt className="text-subtle-foreground">{t("install.size")}</dt>
        <dd className="tabular-nums text-foreground">{formatBytes(target.sizeBytes)}</dd>
        {listing.id.startsWith("@") ? (
          <>
            <dt className="text-subtle-foreground">{t("install.publisher")}</dt>
            <dd className="font-mono text-foreground">{listing.handle}</dd>
          </>
        ) : null}
        <dt className="text-subtle-foreground">{t("install.checksum")}</dt>
        <dd className="truncate font-mono text-foreground" title={`sha256:${target.contentHash}`}>
          sha256:{target.contentHash.slice(0, 16)}…
        </dd>
      </dl>

      {installError ? (
        <p className="rounded-8 bg-destructive-bg px-3 py-2 text-aux text-destructive-fg">
          {installError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={installing}>
          {t("install.cancel")}
        </Button>
        <Button
          type="button"
          onClick={() => void handleInstall()}
          disabled={installing}
          aria-label={installing ? t("install.installing") : undefined}
        >
          {installing ? (
            <>
              <Spinner label={t("install.installing")} />
              <span aria-hidden>{t("install.installing")}</span>
            </>
          ) : (
            t("install.confirm", { version: target.version })
          )}
        </Button>
      </div>
    </section>
  );
}

interface AppIconProps {
  displayName: string;
  iconUrl: string | null;
}

function AppIcon({ displayName, iconUrl }: AppIconProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [iconUrl]);

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        className="h-12 w-12 shrink-0 rounded-12"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-12 bg-surface-muted text-ui text-muted-foreground">
      {displayName.charAt(0).toUpperCase()}
    </div>
  );
}
