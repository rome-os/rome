import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiToolsPanel, hasConnectedAiProvider } from "@/components/ai-tools-panel";
import { Button } from "@/components/ui/button";

// Core built-in rendering of the welcome conversation's `connect_ai` step. The
// turn parks with a `pending_interaction` whose render is `{ kind: "inline",
// componentId: "ai-tools-card", builtin: true }`; this card embeds the same AI
// tools panel the settings page uses, limited to the Claude and ChatGPT
// sign-ins. It resolves with `{ connected: true }` once a provider is signed
// in, so a login that leaves the page (the Codex browser flow) resolves on
// return. "Skip for now" resolves with `{ skip: true }`.
//
// The card probes the status itself before mounting the panel. Mounting first
// and waiting for the panel's own probe would show sign-in buttons to a
// guardian who already has a provider, then snatch them away a moment later.

const HIDDEN_PROVIDERS = ["gemini", "grok"] as const;

type Probe = "checking" | "connected" | "absent";

export interface AiToolsCardProps {
  toolUseId: string;
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  onSubmit: (toolUseId: string, output: Record<string, unknown>, summary?: string) => void;
}

export function AiToolsCard({ toolUseId, result, onSubmit }: AiToolsCardProps) {
  const { t } = useTranslation("chat");
  const [sent, setSent] = useState(false);
  const [probe, setProbe] = useState<Probe>("checking");
  const resolved = result !== undefined || sent;

  const submit = useCallback(
    (output: Record<string, unknown>, summary: string) => {
      setSent(true);
      onSubmit(toolUseId, output, summary);
    },
    [onSubmit, toolUseId],
  );

  // A resolved card is a transcript row, so it never probes.
  useEffect(() => {
    if (result !== undefined) return;
    let cancelled = false;
    void fetch("/api/ai-tools/status", { credentials: "include" })
      .then((res) => res.json())
      .then((status: Record<string, { loggedIn?: boolean } | null>) => {
        if (cancelled) return;
        setProbe(hasConnectedAiProvider(status, HIDDEN_PROVIDERS) ? "connected" : "absent");
      })
      .catch(() => {
        // A failed probe offers the panel rather than blocking the step.
        if (!cancelled) setProbe("absent");
      });
    return () => {
      cancelled = true;
    };
  }, [result]);

  useEffect(() => {
    if (probe === "connected" && !resolved) {
      submit({ connected: true }, t("aiToolsCard.connectedSummary"));
    }
  }, [probe, resolved, submit, t]);

  const connected = result?.connected === true || (sent && probe === "connected");
  const skipped = result?.skip === true || result?.dismissed === true;

  return (
    <div className="mb-4 rounded-12 border border-border bg-surface">
      <div className="p-4">
        <p className="text-ui text-foreground">
          {connected ? t("aiToolsCard.connectedTitle") : t("aiToolsCard.title")}
        </p>
        {!resolved && probe === "absent" ? (
          <>
            <p className="mt-1 text-aux text-muted-foreground">{t("aiToolsCard.hint")}</p>
            <div className="mt-4">
              <AiToolsPanel
                hiddenProviders={HIDDEN_PROVIDERS}
                showHeader={false}
                showUsage={false}
                onConnectedChange={(isConnected) => {
                  if (isConnected) setProbe("connected");
                }}
              />
            </div>
          </>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-aux text-muted-foreground">
          {connected
            ? t("aiToolsCard.connected")
            : skipped
              ? t("aiToolsCard.skipped")
              : probe === "checking"
                ? t("aiToolsCard.checking")
                : t("aiToolsCard.waiting")}
        </span>
        {!resolved && probe === "absent" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => submit({ skip: true }, t("aiToolsCard.skippedSummary"))}
          >
            {t("aiToolsCard.skip")}
          </Button>
        )}
      </div>
    </div>
  );
}
