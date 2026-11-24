import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiToolSignInCardProps } from "@rome/api-types/ai-tool-sign-in-card";
import type { RomeCreditsView } from "@rome/api-types/rome-credits";
import {
  type AiToolProviderId,
  AiToolsPanel,
  hasConnectedAiProvider,
} from "@/components/ai-tools-panel";
import {
  formatCreditDollars,
  hasUsableRomeCredits,
  readRomeCredits,
} from "@/components/rome-credits-row";
import { Button } from "@/components/ui/button";

// Core built-in rendering of the built-in `connect_ai` step of a scripted conversation. The
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
//
// Given `aiTools`, it is instead `system:sign_in_ai_tool`'s card: the panel
// shows only those AI tools, the card answers once one of them is signed in,
// whatever else is, and it offers neither a skip nor credits.

const HIDDEN_PROVIDERS = ["gemini", "grok"] as const;

/** The panel's row for each AI tool the agent names. */
const PANEL_ROWS = {
  claude: { statusKey: "claude", i18nKey: "claudeCode" },
  chatgpt: { statusKey: "codex", i18nKey: "codex" },
} as const satisfies Record<
  AiToolSignInCardProps["aiTools"][number],
  { statusKey: AiToolProviderId; i18nKey: string }
>;

type Probe = "checking" | "connected" | "absent";

/** How long an unconnected card waits for the credits read before opening
 *  with its plain wording. */
const CREDITS_GRACE_MS = 1_500;

/** How long the card waits before asking again for a ChatGPT login whose
 *  first probe has not settled. */
const STATUS_RETRY_MS = 1_000;

export interface AiToolsCardProps {
  toolUseId: string;
  /** The AI tools to sign in to, outside onboarding. */
  aiTools?: AiToolSignInCardProps["aiTools"];
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  onSubmit: (
    toolUseId: string,
    output: Record<string, unknown>,
    summary?: string,
  ) => void | Promise<void>;
}

interface Submission {
  output: Record<string, unknown>;
  summary: string;
}

export function AiToolsCard({ toolUseId, aiTools, result, onSubmit }: AiToolsCardProps) {
  const { t, i18n } = useTranslation("chat");
  const { t: tSettings } = useTranslation("settings");
  const named = aiTools !== undefined;
  const aiToolsKey = aiTools?.join(",");
  const hiddenProviders = useMemo<readonly AiToolProviderId[]>(() => {
    if (!aiToolsKey) return HIDDEN_PROVIDERS;
    const shown = aiToolsKey.split(",") as AiToolSignInCardProps["aiTools"];
    const others = (Object.keys(PANEL_ROWS) as AiToolSignInCardProps["aiTools"])
      .filter((id) => !shown.includes(id))
      .map((id) => PANEL_ROWS[id].statusKey);
    return [...HIDDEN_PROVIDERS, ...others];
  }, [aiToolsKey]);
  const [sent, setSent] = useState(false);
  const [sentWithCredits, setSentWithCredits] = useState(false);
  // An answer that did not go through. The card hides its controls once it
  // sends, so a failed send brings back one way to send the same answer again,
  // and the connected probe stops sending it on its own.
  const [failed, setFailed] = useState<Submission | null>(null);
  const [probe, setProbe] = useState<Probe>("checking");
  const [credits, setCredits] = useState<RomeCreditsView | null>(null);
  const resolved = result !== undefined || sent;

  const submit = useCallback(
    (output: Record<string, unknown>, summary: string) => {
      setSent(true);
      setSentWithCredits(output.credits === true);
      setFailed(null);
      Promise.resolve(onSubmit(toolUseId, output, summary)).catch(() => {
        setSent(false);
        setSentWithCredits(false);
        setFailed({ output, summary });
      });
    },
    [onSubmit, toolUseId],
  );

  // A resolved card is a transcript row, so it never probes.
  useEffect(() => {
    if (result !== undefined) return;
    let cancelled = false;
    type Status = Record<string, { loggedIn?: boolean } | null>;
    const readStatus = (): Promise<Status> =>
      fetch("/api/ai-tools/status", { credentials: "include" }).then((res) => res.json());
    void readStatus()
      .then(async (first) => {
        let status = first;
        if (named) {
          if (!cancelled) {
            setProbe(hasConnectedAiProvider(status, hiddenProviders) ? "connected" : "absent");
          }
          return;
        }
        // Right after boot the first Codex probe may not have settled. Ask
        // once more before settling, since only a signed-out ChatGPT lets
        // credits pay.
        if (!hasConnectedAiProvider(status, HIDDEN_PROVIDERS) && status.codex?.loggedIn == null) {
          await new Promise((resolve) => setTimeout(resolve, STATUS_RETRY_MS));
          if (cancelled) return;
          status = await readStatus().catch(() => status);
        }
        if (hasConnectedAiProvider(status, HIDDEN_PROVIDERS)) {
          // A connected guardian advances without waiting on Rome Cloud.
          if (!cancelled) setProbe("connected");
          return;
        }
        // Rome counts an unknown ChatGPT login as connected, so credits
        // are offered only once ChatGPT reads as signed out.
        if (status.codex?.loggedIn !== false) {
          if (!cancelled) setProbe("absent");
          return;
        }
        // Credits only change the wording, so a failed read shows the plain
        // card. Wait briefly so the card opens with the right wording, but
        // never hold the step on a slow Rome Cloud. A late read is dropped
        // rather than swapping the buttons under the guardian's cursor.
        const creditsProbe = readRomeCredits().then((credits) => credits ?? null);
        const early = await Promise.race([
          creditsProbe,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), CREDITS_GRACE_MS)),
        ]);
        if (cancelled) return;
        setCredits(early);
        setProbe("absent");
      })
      .catch(() => {
        // A failed probe offers the panel rather than blocking the step.
        if (!cancelled) setProbe("absent");
      });
    return () => {
      cancelled = true;
    };
  }, [result, named, hiddenProviders]);

  useEffect(() => {
    if (probe === "connected" && !resolved && !failed) {
      submit({ connected: true }, t("aiToolsCard.connectedSummary"));
    }
  }, [probe, resolved, failed, submit, t]);

  const usingCredits = result ? result.credits === true : sentWithCredits;
  const connected =
    !usingCredits && (result?.connected === true || (sent && probe === "connected"));
  const skipped = result?.skip === true || result?.dismissed === true;
  const offerCredits = !resolved && probe === "absent" && hasUsableRomeCredits(credits);
  const names = aiTools
    ? new Intl.ListFormat(i18n.language, { type: "disjunction" }).format(
        aiTools.map((id) => tSettings(`aiTools.providers.${PANEL_ROWS[id].i18nKey}.name`)),
      )
    : "";

  return (
    <div
      tabIndex={-1}
      data-chat-pending-card={!resolved && (probe === "absent" || failed) ? "" : undefined}
      className="mb-4 rounded-12 border border-border bg-surface"
    >
      <div className="p-4">
        <p className="text-ui text-foreground">
          {named
            ? t("aiToolsCard.signIn.title", { names })
            : connected
              ? t("aiToolsCard.connectedTitle")
              : usingCredits
                ? t("aiToolsCard.credits.usingTitle")
                : offerCredits
                  ? t("aiToolsCard.credits.title")
                  : t("aiToolsCard.title")}
        </p>
        {!resolved && probe === "absent" ? (
          <>
            {!named && (
              <p className="mt-1 text-aux text-muted-foreground">
                {offerCredits && credits
                  ? t("aiToolsCard.credits.hint", {
                      amount: formatCreditDollars(credits.availableMicros, i18n.language),
                    })
                  : t("aiToolsCard.hint")}
              </p>
            )}
            <div className="mt-4">
              <AiToolsPanel
                hiddenProviders={hiddenProviders}
                showHeader={false}
                showUsage={false}
                showRomeCredits={offerCredits}
                romeCredits={credits}
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
          {failed && !resolved
            ? t("aiToolsCard.sendFailed")
            : connected
              ? t("aiToolsCard.connected")
              : usingCredits
                ? t("aiToolsCard.credits.using")
                : skipped
                  ? t(named ? "aiToolsCard.signIn.dismissed" : "aiToolsCard.skipped")
                  : probe === "checking"
                    ? t("aiToolsCard.checking")
                    : offerCredits
                      ? t("aiToolsCard.credits.ready")
                      : t("aiToolsCard.waiting")}
        </span>
        {failed && !resolved ? (
          <Button type="button" size="sm" onClick={() => submit(failed.output, failed.summary)}>
            {t("aiToolsCard.retry")}
          </Button>
        ) : offerCredits ? (
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
          !named &&
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
