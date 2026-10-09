import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RomeCreditsResponse, RomeCreditsView } from "@rome/api-types/rome-credits";
import { AiToolsPanel, hasConnectedAiProvider } from "@/components/ai-tools-panel";
import { formatCreditDollars, hasUsableRomeCredits } from "@/components/rome-credits-row";
import { Button } from "@/components/ui/button";

// Core built-in rendering of the welcome conversation's `connect_ai` step. The
// turn parks with a `pending_interaction` whose render is `{ kind: "inline",
// componentId: "ai-tools-card", builtin: true }`; this card embeds the same AI
// tools panel the settings page uses, limited to the Claude and ChatGPT
// sign-ins. It resolves with `{ connected: true }` once a provider is signed
// in, so a login that leaves the page (the Codex browser flow) resolves on
// return. "Skip for now" resolves with `{ skip: true }`. When the account has
// Rome credits left, the card offers them instead of a skip and resolves with
// `{ connected: true, credits: true }`, because credits run Rome as a sign-in
// would.
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
  const { t, i18n } = useTranslation("chat");
  const [sent, setSent] = useState(false);
  const [sentWithCredits, setSentWithCredits] = useState(false);
  const [probe, setProbe] = useState<Probe>("checking");
  const [credits, setCredits] = useState<RomeCreditsView | null>(null);
  const resolved = result !== undefined || sent;

  const submit = useCallback(
    (output: Record<string, unknown>, summary: string) => {
      setSent(true);
      setSentWithCredits(output.credits === true);
      onSubmit(toolUseId, output, summary);
    },
    [onSubmit, toolUseId],
  );

  // A resolved card is a transcript row, so it never probes.
  useEffect(() => {
    if (result !== undefined) return;
    let cancelled = false;
    // Credits only change the wording, so a failed read shows the plain card.
    const creditsProbe = fetch("/api/ai-tools/rome-credits", { credentials: "include" })
      .then((res) => (res.ok ? (res.json() as Promise<RomeCreditsResponse>) : null))
      .then((data) => data?.credits ?? null)
      .catch(() => null);
    void fetch("/api/ai-tools/status", { credentials: "include" })
      .then((res) => res.json())
      .then(async (status: Record<string, { loggedIn?: boolean } | null>) => {
        const nextCredits = await creditsProbe;
        if (cancelled) return;
        setCredits(nextCredits);
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

  const usingCredits = result ? result.credits === true : sentWithCredits;
  const connected =
    !usingCredits && (result?.connected === true || (sent && probe === "connected"));
  const skipped = result?.skip === true || result?.dismissed === true;
  const offerCredits = !resolved && probe === "absent" && hasUsableRomeCredits(credits);

  return (
    <div className="mb-4 rounded-12 border border-border bg-surface">
      <div className="p-4">
        <p className="text-ui text-foreground">
          {connected
            ? t("aiToolsCard.connectedTitle")
            : usingCredits
              ? t("aiToolsCard.credits.usingTitle")
              : offerCredits
                ? t("aiToolsCard.credits.title")
                : t("aiToolsCard.title")}
        </p>
        {!resolved && probe === "absent" ? (
          <>
            <p className="mt-1 text-aux text-muted-foreground">
              {offerCredits && credits
                ? t("aiToolsCard.credits.hint", {
                    amount: formatCreditDollars(credits.availableMicros, i18n.language),
                  })
                : t("aiToolsCard.hint")}
            </p>
            <div className="mt-4">
              <AiToolsPanel
                hiddenProviders={HIDDEN_PROVIDERS}
                showHeader={false}
                showUsage={false}
                showRomeCredits={offerCredits}
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
            : usingCredits
              ? t("aiToolsCard.credits.using")
              : skipped
                ? t("aiToolsCard.skipped")
                : probe === "checking"
                  ? t("aiToolsCard.checking")
                  : offerCredits
                    ? t("aiToolsCard.credits.ready")
                    : t("aiToolsCard.waiting")}
        </span>
        {offerCredits ? (
          <Button
            type="button"
            size="sm"
            onClick={() =>
              submit({ connected: true, credits: true }, t("aiToolsCard.credits.summary"))
            }
          >
            {t("aiToolsCard.credits.continue")}
          </Button>
        ) : (
          !resolved &&
          probe === "absent" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => submit({ skip: true }, t("aiToolsCard.skippedSummary"))}
            >
              {t("aiToolsCard.skip")}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
