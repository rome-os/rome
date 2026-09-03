import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiToolsPanel } from "@/components/ai-tools-panel";
import { Button } from "@/components/ui/button";

// Core built-in rendering of the welcome conversation's `connect_ai` step. The
// turn parks with a `pending_interaction` whose render is `{ kind: "inline",
// componentId: "ai-tools-card", builtin: true }`; this card embeds the same AI
// tools panel the settings page and the onboarding page use, limited to the
// Claude and ChatGPT sign-ins. It resolves itself with `{ connected: true }` as
// soon as the status probe reports a provider logged in, so a login that
// leaves the page (the Codex browser flow) resolves on return, and an instance
// that already holds a provider resolves on mount. "Skip for now" resolves
// with `{ skip: true }`.

const HIDDEN_PROVIDERS = ["gemini", "grok"] as const;

export interface AiToolsCardProps {
  toolUseId: string;
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  onSubmit: (toolUseId: string, output: Record<string, unknown>, summary?: string) => void;
}

export function AiToolsCard({ toolUseId, result, onSubmit }: AiToolsCardProps) {
  const { t } = useTranslation("chat");
  const [sent, setSent] = useState(false);
  const resolved = result !== undefined || sent;
  const outcome =
    result?.connected === true
      ? "connected"
      : result?.dismissed === true || result?.skip === true
        ? "skipped"
        : sent
          ? "connected"
          : null;

  const handleConnectedChange = useCallback(
    (connected: boolean) => {
      if (!connected || resolved) return;
      setSent(true);
      onSubmit(toolUseId, { connected: true }, t("aiToolsCard.connectedSummary"));
    },
    [onSubmit, resolved, t, toolUseId],
  );

  const skip = () => {
    if (resolved) return;
    setSent(true);
    onSubmit(toolUseId, { skip: true }, t("aiToolsCard.skippedSummary"));
  };

  return (
    <div className="mb-4 rounded-12 border border-border bg-surface">
      <div className="p-4">
        <p className="text-ui text-foreground">{t("aiToolsCard.title")}</p>
        <p className="mt-1 text-aux text-muted-foreground">{t("aiToolsCard.hint")}</p>
        {!resolved ? (
          <div className="mt-4">
            <AiToolsPanel
              hiddenProviders={HIDDEN_PROVIDERS}
              showHeader={false}
              showUsage={false}
              onConnectedChange={handleConnectedChange}
            />
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-aux text-muted-foreground">
          {outcome === "connected"
            ? t("aiToolsCard.connected")
            : outcome === "skipped"
              ? t("aiToolsCard.skipped")
              : t("aiToolsCard.waiting")}
        </span>
        {!resolved && (
          <Button type="button" variant="ghost" size="sm" onClick={skip}>
            {t("aiToolsCard.skip")}
          </Button>
        )}
      </div>
    </div>
  );
}
