import { Section, SectionHeader, SectionTitle } from "@rome-os/ui/page";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchJson } from "@/lib/fetch-json";
import { beginInstanceEnroll } from "@/lib/instance-enroll";

/** Mirrors GET /api/diagnosis from @rome/core. */
interface DiagnosisResponse {
  status: "ok" | "degraded";
  checkedAt: string;
  uptimeSeconds: number;
  build: { version: string | null; sha: string | null; builtAt: string | null };
  upgradedSinceLastBoot: boolean;
  previousVersion: string | null;
  instance: {
    auth: "ok" | "revoked" | "unknown" | "no_token" | "unconfigured" | "unreachable";
    accountId: string | null;
    instanceId: string | null;
  };
  database: { ok: boolean };
  relay: { configured: boolean; depositUrlConfigured: boolean };
  channels: string[];
  apps: { total: number; failed: string[]; broken: string[] };
}

type AuthStatus = DiagnosisResponse["instance"]["auth"];

// How each Rome Cloud identity outcome reads to a guardian. `revoked`/`unknown`
// are the terminal "this instance is no longer valid" signals (the only ones
// that fail the overall verdict); `unreachable` is a transient miss; `no_token`
// and `unconfigured` are expected non-error states (not enrolled / source build).
const AUTH_BADGE: Record<AuthStatus, "success" | "warning" | "destructive" | "muted"> = {
  ok: "success",
  unreachable: "warning",
  revoked: "destructive",
  unknown: "destructive",
  no_token: "muted",
  unconfigured: "muted",
};

// The states where re-running the enroll flow is the fix: Rome Cloud rejected the
// token (revoked/unknown) or there is none (no_token — e.g. after the identity
// heartbeat cleared a revoked credential). `unreachable` is transient and
// `unconfigured` is a source build, so neither offers a reconnect.
const NEEDS_RECONNECT: ReadonlySet<AuthStatus> = new Set(["revoked", "unknown", "no_token"]);

export function SystemDiagnosisSection() {
  const { t } = useTranslation("settings");
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState("");

  async function reconnect() {
    setReconnecting(true);
    setReconnectError("");
    const result = await beginInstanceEnroll();
    // Success navigates away to Rome Cloud; we only land here on failure.
    if (!result.ok) {
      setReconnectError(t("advanced.diagnosis.reconnectFailed"));
      setReconnecting(false);
    }
  }
  // Verifying identity contacts Rome Cloud on every call, so this fetches once on
  // mount rather than polling; a page reload is the way to get a fresh snapshot.
  const query = useQuery({
    queryKey: ["diagnosis"] as const,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      fetchJson<DiagnosisResponse>("/api/diagnosis", {
        signal,
        fallback: t("advanced.diagnosis.loadFailed"),
      }),
  });
  const d = query.data ?? null;
  const relay = d?.relay ?? { configured: false, depositUrlConfigured: false };

  return (
    <Section>
      <SectionHeader>
        <SectionTitle>{t("advanced.diagnosis.title")}</SectionTitle>
        {d && (
          <Badge variant={d.status === "ok" ? "success" : "destructive"}>
            {t(`advanced.diagnosis.status.${d.status}`)}
          </Badge>
        )}
      </SectionHeader>

      {query.isLoading ? (
        <p className="text-ui text-muted-foreground">{t("advanced.diagnosis.loading")}</p>
      ) : !d ? (
        <div className="flex items-center gap-2">
          <p className="text-ui text-destructive-fg">
            {query.error instanceof Error
              ? query.error.message
              : t("advanced.diagnosis.loadFailed")}
          </p>
          <Button variant="outline" size="xs" onClick={() => void query.refetch()}>
            {t("advanced.diagnosis.refresh")}
          </Button>
        </div>
      ) : (
        <Card>
          <CardContent>
            <dl className="space-y-3 text-ui">
              <DiagRow label={t("advanced.diagnosis.version")}>
                {d.build.version ?? (
                  <span className="text-muted-foreground">
                    {t("advanced.diagnosis.unversioned")}
                  </span>
                )}
              </DiagRow>
              <DiagRow label={t("advanced.diagnosis.commit")}>
                {d.build.sha ? <span className="font-mono text-aux">{d.build.sha}</span> : <Dash />}
              </DiagRow>
              <DiagRow label={t("advanced.diagnosis.builtAt")}>
                {d.build.builtAt ? formatDate(d.build.builtAt) : <Dash />}
              </DiagRow>
              <DiagRow label={t("advanced.diagnosis.uptime")}>
                {formatUptime(d.uptimeSeconds)}
              </DiagRow>
              <DiagRow label={t("advanced.diagnosis.enrollment")}>
                <div className="flex items-center justify-end gap-2">
                  <Badge variant={AUTH_BADGE[d.instance.auth]}>
                    {t(`advanced.diagnosis.auth.${d.instance.auth}`)}
                  </Badge>
                  {NEEDS_RECONNECT.has(d.instance.auth) && (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={reconnecting}
                      onClick={() => void reconnect()}
                    >
                      {reconnecting
                        ? t("advanced.diagnosis.reconnecting")
                        : t("advanced.diagnosis.reconnect")}
                    </Button>
                  )}
                </div>
              </DiagRow>
              {reconnectError && (
                <p className="text-right text-aux text-destructive-fg">{reconnectError}</p>
              )}
              {d.instance.auth === "ok" && d.instance.accountId && (
                <DiagRow label={t("advanced.diagnosis.account")}>
                  <span className="break-all font-mono text-aux">{d.instance.accountId}</span>
                </DiagRow>
              )}
              <DiagRow label={t("advanced.diagnosis.database")}>
                <span className={d.database.ok ? "text-success-fg" : "text-destructive-fg"}>
                  {d.database.ok
                    ? t("advanced.diagnosis.dbReachable")
                    : t("advanced.diagnosis.dbUnreachable")}
                </span>
              </DiagRow>
              <DiagRow label={t("advanced.diagnosis.relayDepositUrl")}>
                {relay.configured ? (
                  <span
                    className={relay.depositUrlConfigured ? "text-success-fg" : "text-warning-fg"}
                  >
                    {relay.depositUrlConfigured
                      ? t("advanced.diagnosis.relayDepositConfigured")
                      : t("advanced.diagnosis.relayDepositMissing")}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {t("advanced.diagnosis.relayNotConfigured")}
                  </span>
                )}
              </DiagRow>
              <DiagRow label={t("advanced.diagnosis.channels")}>
                {d.channels.length > 0 ? (
                  d.channels.join(", ")
                ) : (
                  <span className="text-muted-foreground">
                    {t("advanced.diagnosis.noChannels")}
                  </span>
                )}
              </DiagRow>
              <DiagRow label={t("advanced.diagnosis.apps")}>
                {d.apps.failed.length === 0 && d.apps.broken.length === 0 ? (
                  t("advanced.diagnosis.appsHealthy", { count: d.apps.total })
                ) : (
                  <span className="text-destructive-fg">
                    {t("advanced.diagnosis.appsUnhealthy", {
                      count: d.apps.total,
                      ids: [...d.apps.failed, ...d.apps.broken].join(", "),
                    })}
                  </span>
                )}
              </DiagRow>
            </dl>
          </CardContent>
        </Card>
      )}
    </Section>
  );
}

function DiagRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground">{children}</dd>
    </div>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  // Always show minutes so a fresh boot reads "0m" rather than an empty string.
  parts.push(`${m}m`);
  return parts.join(" ");
}
