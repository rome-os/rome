import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { getApiErrorMessage } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Timestamp } from "@rome-os/ui/timestamp";
import { PageShell, PageBody } from "@/shell/PageShell";

// ── Types ──────────────────────────────────────────────
// The Inbox page reads the same host endpoints the Settings page used before
// these surfaces were consolidated here: /api/settings (triage policy),
// /api/sentinel-log (triage activity), /api/connections (source overview).

interface InboxSettings {
  sentinelReviewIntervalMinutes?: number;
  trustedBondLevels?: string[];
  replyToBondLevels?: string[];
}

interface SentinelEntry {
  id: string;
  channel: string;
  channelUserId: string;
  displayName: string | null;
  text: string | null;
  action: string;
  response: string | null;
  reviewed: boolean | null;
  createdAt: string;
}

// Lean subset of /api/connections — only what the read-only source overview
// needs: per-service grant states (conferred or not) and whether the Talk
// capability is actually unlocked (the live transport).
interface ConnectionLite {
  service: string;
  grants: Record<string, "unauthorized" | "authorized" | "degraded">;
  capabilities: { talk: { state: string } };
}

// "configured" = set up but the live connection is not currently open (pending
// QR/login, reconnecting, or errored) — distinct from a confirmed "connected".
type SourceStatus = "connected" | "configured" | "awaiting" | "disconnected" | "alwaysOn";

const ALL_BOND_LEVELS = ["guardian", "inner-circle", "acquaintance", "other"] as const;
const DEFAULT_TRUSTED_LEVELS = ["guardian"];
const DEFAULT_REPLY_TO_LEVELS = ["guardian"];

const CHANNELS_SETTINGS_HREF = "/settings/connections";

// ── Page ───────────────────────────────────────────────

export default function InboxPage() {
  const { t } = useTranslation("inbox");
  const [settings, setSettings] = useState<InboxSettings>({});
  const [sentinelLog, setSentinelLog] = useState<SentinelEntry[]>([]);
  const [connections, setConnections] = useState<ConnectionLite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, slRes, cRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/sentinel-log"),
        fetch("/api/connections"),
      ]);
      // Guard each payload: an unauthenticated/error response returns a non-OK
      // body (e.g. `{ error }`), so never feed it straight into state — that
      // would crash the sentinel-log `.map` and the settings reads.
      if (sRes.ok) setSettings((await sRes.json()) as InboxSettings);
      if (slRes.ok) {
        const log = await slRes.json();
        setSentinelLog(Array.isArray(log) ? (log as SentinelEntry[]) : []);
      }
      if (cRes.ok) {
        const payload = (await cRes.json()) as {
          connections?: ConnectionLite[];
        };
        setConnections(Array.isArray(payload.connections) ? payload.connections : []);
      }
    } catch (err) {
      console.error("Failed to load inbox data", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Resolves to whether the save landed, so optimistic UI (the trust toggles)
  // can roll back when the backend kept the old value.
  const saveSettings = useCallback(
    async (patch: Record<string, unknown>): Promise<boolean> => {
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
        flash(t("page.savedFlash"));
        return true;
      } catch (error) {
        flash(error instanceof Error ? error.message : t("page.saveFailedFallback"));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [flash, t],
  );

  return (
    <PageShell>
      <PageBody>
        {/* Header renders above the load switch so a slow read leaves the page
            identity in place instead of blanking the route. */}
        <div>
          <h1 className="text-title text-foreground">{t("page.title")}</h1>
          <p className="mt-1 text-body text-muted-foreground">{t("page.description")}</p>
        </div>

        {toast && (
          <div className="fixed right-4 top-4 z-50 rounded-8 border border-success-border bg-success-bg px-4 py-2 text-ui text-success-fg shadow-10">
            {toast}
          </div>
        )}

        {/* Triage rows are label/control pairs like Settings', so the column
            keeps a reading measure while the frame above stays full-bleed. */}
        <div className="max-w-3xl">
          {loading ? (
            <p className="text-ui text-muted-foreground">{t("page.loading")}</p>
          ) : (
            <div className="space-y-10">
              <MessageSourcesSection connections={connections} />
              <TriagePolicySection settings={settings} onSave={saveSettings} saving={saving} />
              <TriageActivitySection entries={sentinelLog} onRefresh={loadAll} />
            </div>
          )}
        </div>
      </PageBody>
    </PageShell>
  );
}

// ── Section: Triage activity (was Settings → Advanced → Sentinel Log) ───

function TriageActivitySection({
  entries,
  onRefresh,
}: {
  entries: SentinelEntry[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("inbox");
  const { t: ts } = useTranslation("settings");

  async function markReviewed(id: string) {
    await fetch(`/api/sentinel-log/${id}/review`, { method: "POST" });
    await onRefresh();
  }

  return (
    <section>
      <h2 className="text-section text-foreground">{t("triage.title")}</h2>
      <p className="mb-4 mt-1 text-body text-muted-foreground">{t("triage.description")}</p>
      {entries.length === 0 ? (
        <p className="text-ui text-muted-foreground">{ts("sentinelLog.empty")}</p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={cn(
                "rounded-8 border p-4",
                entry.reviewed
                  ? "border-border bg-surface-muted"
                  : "border-warning-border bg-warning-bg",
              )}
            >
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-aux text-muted-foreground">{entry.channel}</span>
                  <span className="text-ui text-foreground">
                    {entry.displayName || entry.channelUserId}
                  </span>
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2 py-1 text-badge",
                      entry.action === "replied"
                        ? "bg-info-bg text-info-fg"
                        : entry.action === "escalated"
                          ? "bg-destructive-bg text-destructive-fg"
                          : "bg-surface-muted text-muted-foreground",
                    )}
                  >
                    {entry.action}
                  </span>
                </div>
                <Timestamp
                  value={entry.createdAt}
                  format="datetime"
                  className="text-aux text-subtle-foreground"
                />
              </div>

              {entry.text && <p className="mb-1 text-body text-foreground">{entry.text}</p>}
              {entry.response && (
                <p className="text-body italic text-muted-foreground">
                  {ts("sentinelLog.responsePrefix", {
                    response: entry.response,
                  })}
                </p>
              )}

              {!entry.reviewed ? (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => markReviewed(entry.id)}
                  className="mt-2"
                >
                  {ts("sentinelLog.markReviewed")}
                </Button>
              ) : (
                <span className="mt-2 inline-block text-aux text-success-fg">
                  {ts("sentinelLog.reviewed")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Section: Triage policy (was Settings → Advanced → Sentinel + Trust tab) ──

function TriagePolicySection({
  settings,
  onSave,
  saving,
}: {
  settings: InboxSettings;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
  saving: boolean;
}) {
  const { t } = useTranslation("inbox");
  const { t: ts } = useTranslation("settings");
  // Keep the interval as a raw string so clearing the field doesn't coerce to 0
  // and decimals don't silently persist; only a positive integer is saveable.
  const savedInterval = settings.sentinelReviewIntervalMinutes ?? 60;
  const [reviewInterval, setReviewInterval] = useState(String(savedInterval));
  useEffect(() => {
    setReviewInterval(String(savedInterval));
  }, [savedInterval]);
  const parsedInterval = Number(reviewInterval);
  const intervalValid = Number.isInteger(parsedInterval) && parsedInterval >= 1;
  const intervalDirty = parsedInterval !== savedInterval;
  // Like the interval, the toggle arrays resync whenever `settings` refreshes
  // (loadAll runs again after e.g. mark-reviewed), so the policy UI can't keep
  // showing stale local state over newer server truth.
  const savedTrusted = settings.trustedBondLevels ?? DEFAULT_TRUSTED_LEVELS;
  const savedReplyTo = settings.replyToBondLevels ?? DEFAULT_REPLY_TO_LEVELS;
  const [trustedLevels, setTrustedLevels] = useState<string[]>(savedTrusted);
  const [replyToLevels, setReplyToLevels] = useState<string[]>(savedReplyTo);
  useEffect(() => {
    setTrustedLevels(savedTrusted);
  }, [savedTrusted]);
  useEffect(() => {
    setReplyToLevels(savedReplyTo);
  }, [savedReplyTo]);

  // The toggles flip optimistically for responsiveness, but roll back when the
  // PUT fails — otherwise the page would show a triage policy the backend never
  // accepted.
  function setTrustedBondLevel(level: string, enabled: boolean) {
    const previous = trustedLevels;
    const next = enabled
      ? Array.from(new Set([...previous, level]))
      : previous.filter((l) => l !== level);
    setTrustedLevels(next);
    void onSave({ trustedBondLevels: next }).then((saved) => {
      if (!saved) setTrustedLevels(previous);
    });
  }

  function setReplyToBondLevel(level: string, enabled: boolean) {
    const previous = replyToLevels;
    const next = enabled
      ? Array.from(new Set([...previous, level]))
      : previous.filter((l) => l !== level);
    setReplyToLevels(next);
    void onSave({ replyToBondLevels: next }).then((saved) => {
      if (!saved) setReplyToLevels(previous);
    });
  }

  return (
    <section>
      <h2 className="text-section text-foreground">{t("policy.title")}</h2>
      <p className="mb-6 mt-1 text-body text-muted-foreground">{t("policy.description")}</p>

      <div className="space-y-8">
        {/* Review interval */}
        <div>
          <h3 className="mb-2 text-section text-foreground">{ts("sentinel.title")}</h3>
          <div className="flex items-center gap-2">
            <FieldLabel htmlFor="sentinel-review-interval">
              {ts("sentinel.intervalLabel")}
            </FieldLabel>
            <Input
              id="sentinel-review-interval"
              type="number"
              min={1}
              step={1}
              value={reviewInterval}
              disabled={saving}
              onChange={(e) => setReviewInterval(e.target.value)}
              aria-invalid={!intervalValid}
              className="w-24"
            />
            <Button
              disabled={saving || !intervalValid || !intervalDirty}
              onClick={() => onSave({ sentinelReviewIntervalMinutes: parsedInterval })}
              className="ml-3"
            >
              {saving ? ts("common.saving") : ts("common.save")}
            </Button>
          </div>
          <FieldDescription className="mt-1">{ts("sentinel.intervalHelp")}</FieldDescription>
        </div>

        {/* Trusted levels */}
        <div>
          <h3 className="mb-2 text-section text-foreground">{ts("trust.trustedLevels.title")}</h3>
          <p className="mb-4 text-body text-muted-foreground">
            {ts("trust.trustedLevels.description")}
          </p>
          <div className="space-y-3">
            {ALL_BOND_LEVELS.map((level) => (
              <BondLevelToggle
                key={level}
                label={ts(`trust.levels.${level}` as const)}
                checked={trustedLevels.includes(level)}
                disabled={saving}
                onChange={(enabled) => setTrustedBondLevel(level, enabled)}
              />
            ))}
          </div>
        </div>

        {/* Reply-to levels */}
        <div>
          <h3 className="mb-2 text-section text-foreground">{ts("trust.replyToLevels.title")}</h3>
          <p className="mb-4 text-body text-muted-foreground">
            {ts("trust.replyToLevels.description")}
          </p>
          <div className="space-y-3">
            {ALL_BOND_LEVELS.map((level) => (
              <BondLevelToggle
                key={level}
                label={ts(`trust.levels.${level}` as const)}
                checked={replyToLevels.includes(level)}
                disabled={saving}
                onChange={(enabled) => setReplyToBondLevel(level, enabled)}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function BondLevelToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
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

// ── Section: Message sources (read-only overview + deep link) ───────────

// One shared rule over the registry-native projection: a service whose Talk is
// unlocked is connected; a conferred credential (authorized or degraded) whose
// transport is not up reads "configured"; nothing conferred is disconnected.
// The old per-channel nuances (guardian-awaiting, live-socket "open") are
// ceremony detail that lives in Settings → Connections, not this overview.
function sourceStatus(conn: ConnectionLite | undefined): SourceStatus {
  if (!conn) return "disconnected";
  if (conn.capabilities.talk.state === "unlocked") return "connected";
  const conferred = Object.values(conn.grants).some((state) => state !== "unauthorized");
  return conferred ? "configured" : "disconnected";
}

function MessageSourcesSection({ connections }: { connections: ConnectionLite[] | null }) {
  const { t } = useTranslation("inbox");

  const byService = (service: string) => connections?.find((c) => c.service === service);

  const rows: { key: string; status: SourceStatus }[] = [
    { key: "telegram", status: sourceStatus(byService("telegram")) },
    { key: "telegramUser", status: sourceStatus(byService("telegram_user")) },
    { key: "whatsapp", status: sourceStatus(byService("whatsapp")) },
    { key: "wechat", status: sourceStatus(byService("wechat")) },
    { key: "discord", status: sourceStatus(byService("discord")) },
    { key: "webchat", status: "alwaysOn" },
  ];

  const statusTone: Record<SourceStatus, string> = {
    connected: "bg-success-bg text-success-fg",
    configured: "bg-warning-bg text-warning-fg",
    awaiting: "bg-warning-bg text-warning-fg",
    disconnected: "bg-surface-muted text-muted-foreground",
    alwaysOn: "bg-info-bg text-info-fg",
  };

  return (
    <section>
      <h2 className="text-section text-foreground">{t("sources.title")}</h2>
      <p className="mb-4 mt-1 text-body text-muted-foreground">
        <Trans
          i18nKey="sources.description"
          ns="inbox"
          components={{
            // NB: the placeholder tag must not be a void HTML element (e.g.
            // <link>) — react-i18next's parser self-closes those and drops the
            // wrapped text. <a> is a normal element, so the label is preserved.
            a: (
              <Link
                to={CHANNELS_SETTINGS_HREF}
                className="text-foreground underline underline-offset-2"
              />
            ),
          }}
        />
      </p>

      <div className="divide-y divide-border overflow-hidden rounded-8 border border-border bg-surface">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-ui text-foreground">
              {t(`sources.channels.${row.key}` as const)}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-1 text-badge",
                statusTone[row.status],
              )}
            >
              {t(`sources.status.${row.status}` as const)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
