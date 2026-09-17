import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Folder, Link2, Trash2, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import {
  ChatApiError,
  createShare,
  getSession,
  listShares,
  revokeShare,
  type ShareSummary,
} from "@/lib/chat-api";
import { relativeTime } from "@/lib/routine-language";
import { useApps } from "@/hooks/use-apps";
import { useFreeCells, type WidgetPlacement } from "@/pages/free/use-free-cells";

function shareableWidgets(placements: WidgetPlacement[]): WidgetPlacement[] {
  return [...placements]
    .filter((p) => p.type === "app" || p.type === "projects")
    .sort((a, b) => a.order - b.order);
}

// The panel shown while picking turns to share. Turn selection itself lives on
// the MessageList (inline checkboxes); this panel configures which workspace
// panels ride along, mints the link, and lists/revokes existing ones. It takes
// the composer's place so the whole flow stays on the chat surface.
export function ShareBar({
  sessionId,
  selectedTurnIds,
  onExit,
}: {
  sessionId: string;
  selectedTurnIds: string[];
  onExit: () => void;
}) {
  const { t } = useTranslation("chat");
  const { placements } = useFreeCells();
  const { apps } = useApps();
  const widgets = useMemo(() => shareableWidgets(placements), [placements]);
  const appById = useMemo(() => new Map((apps ?? []).map((a) => [a.id, a])), [apps]);

  const [selectedWidgets, setSelectedWidgets] = useState<Set<string>>(
    () => new Set(widgets.map((w) => w.id)),
  );
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  // Which URL was last copied, so each copy affordance shows its own check.
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // The session's project path — shown on the Projects row so the guardian sees
  // exactly which project a workspace share exposes (the backend scopes to it).
  const [projectPath, setProjectPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSession(sessionId)
      .then((session) => {
        if (!cancelled) setProjectPath(session?.projectPath ?? session?.projectName ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Keep widget toggles in sync if the layout changes while the panel is open.
  useEffect(() => {
    setSelectedWidgets(new Set(widgets.map((w) => w.id)));
  }, [widgets]);

  const refreshShares = useCallback(() => {
    listShares(sessionId)
      .then(setShares)
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    refreshShares();
  }, [refreshShares]);

  const toggleWidget = useCallback((id: string) => {
    setSelectedWidgets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCopy = useCallback((url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopiedUrl(url);
        setTimeout(() => setCopiedUrl((cur) => (cur === url ? null : cur)), 1500);
      },
      () => {},
    );
  }, []);

  const handleCreate = useCallback(async () => {
    if (selectedTurnIds.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const layout = widgets.filter((w) => selectedWidgets.has(w.id));
      const result = await createShare(sessionId, { turnIds: selectedTurnIds, layout });
      const url = `${window.location.origin}${result.url}`;
      setCreatedUrl(url);
      handleCopy(url);
      refreshShares();
    } catch (err) {
      setError(
        err instanceof ChatApiError && err.message
          ? err.message
          : t("share.createError", "Couldn't create the link."),
      );
    } finally {
      setCreating(false);
    }
  }, [sessionId, selectedTurnIds, selectedWidgets, widgets, handleCopy, refreshShares, t]);

  const handleRevoke = useCallback(
    async (id: string) => {
      await revokeShare(id).catch(() => {});
      refreshShares();
    },
    [refreshShares],
  );

  const count = selectedTurnIds.length;

  return (
    <div className="rounded-16 border border-border bg-surface/95 p-4 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80">
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-section text-foreground">
            {t("share.createTitle", "Create a share link")}
          </h2>
          <p className="text-ui text-muted-foreground">{t("share.selectedCount", { count })}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onExit}
          aria-label={t("share.cancel", "Cancel")}
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Include in link */}
      {widgets.length > 0 && (
        <div className="mt-4">
          <p className="text-aux text-muted-foreground">
            {t("share.includeLabel", "Include in link")}
          </p>
          <div className="mt-1 divide-y divide-border-subtle">
            {widgets.map((widget) => {
              const on = selectedWidgets.has(widget.id);
              const isProjects = widget.type === "projects";
              const app = widget.targetId ? appById.get(widget.targetId) : undefined;
              const label = isProjects
                ? t("share.projectsTitle", "Project workspace")
                : (app?.displayName ??
                  widget.targetId ??
                  t("nav.apps", { ns: "common", defaultValue: "App" }));
              const desc = isProjects
                ? t("share.projectsDesc", "All files and settings in the linked project.")
                : t("share.appDesc", "Interactive for visitors. The app must be public.");
              return (
                <div key={widget.id} className="flex items-center gap-3 py-3">
                  {isProjects ? (
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-8 bg-surface-muted text-muted-foreground">
                      <Folder className="size-5" />
                    </div>
                  ) : (
                    <AgentAvatar iconUrl={app?.iconUrl} label={label} size="lg" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`text-ui text-foreground ${isProjects ? "shrink-0" : "truncate"}`}
                      >
                        {label}
                      </span>
                      {isProjects && projectPath && (
                        <span
                          className="truncate font-mono text-aux text-muted-foreground"
                          title={projectPath}
                        >
                          {projectPath}
                        </span>
                      )}
                    </div>
                    {isProjects && on ? (
                      <div className="flex items-start gap-1 text-ui text-destructive">
                        <TriangleAlert className="mt-1 size-3.5 shrink-0" />
                        <span>
                          <span>
                            {t("share.projectsDangerLead", "Exposes every file in this project")}
                          </span>{" "}
                          {t("share.projectsDangerBody", "to anyone with the link.")}
                        </span>
                      </div>
                    ) : (
                      <div className="text-ui text-muted-foreground">{desc}</div>
                    )}
                  </div>
                  <Switch
                    checked={on}
                    onCheckedChange={() => toggleWidget(widget.id)}
                    aria-label={label}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Create */}
      <Button
        className="mt-4 w-full"
        onClick={() => void handleCreate()}
        disabled={count === 0 || creating}
      >
        <Link2 className="size-4" />
        {creating ? t("share.creating", "Creating…") : t("share.create", "Create link")}
      </Button>

      {error && <p className="mt-2 text-ui text-destructive">{error}</p>}

      {createdUrl && (
        <div className="mt-3 flex items-center gap-2 rounded-8 border border-primary/30 bg-primary/5 p-2">
          <Check className="size-4 shrink-0 text-primary" />
          <Input
            readOnly
            value={createdUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1"
          />
          <Button variant="outline" onClick={() => handleCopy(createdUrl)}>
            {copiedUrl === createdUrl ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copiedUrl === createdUrl ? t("share.copied", "Copied") : t("share.copy", "Copy")}
          </Button>
        </div>
      )}

      {/* Active links */}
      {shares.length > 0 && (
        <>
          <Separator className="my-4" />
          <div className="flex items-center gap-2">
            <h3 className="text-section text-foreground">
              {t("share.existingHeading", "Active links")}
            </h3>
            <Badge variant="muted" shape="pill">
              {shares.length}
            </Badge>
          </div>
          <div className="mt-1 space-y-1">
            {shares.map((share) => {
              const url = `${window.location.origin}${share.url}`;
              const displayUrl = `${window.location.host}${share.url}`;
              const justCopied = copiedUrl === url;
              return (
                <div
                  key={share.id}
                  className="flex items-center gap-2 rounded-8 py-1 pl-1 pr-1 hover:bg-surface-hover"
                >
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1"
                    title={t("share.open", "Open in new tab")}
                  >
                    <div className="truncate text-ui text-foreground">{share.title}</div>
                    <div className="flex min-w-0 items-center gap-1 text-aux text-muted-foreground">
                      <span className="truncate">{displayUrl}</span>
                      <span className="shrink-0">· {relativeTime(share.createdAt)}</span>
                    </div>
                  </a>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleCopy(url)}
                    aria-label={justCopied ? t("share.copied", "Copied") : t("share.copy", "Copy")}
                    title={justCopied ? t("share.copied", "Copied") : t("share.copy", "Copy")}
                  >
                    {justCopied ? (
                      <Check className="size-4 text-primary" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void handleRevoke(share.id)}
                    className="text-subtle-foreground hover:text-destructive"
                    aria-label={t("share.revoke", "Revoke")}
                    title={t("share.revoke", "Revoke")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
