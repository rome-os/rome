import { useCallback, useState } from "react";
import { TURN_BRANCH_PROMPT_MAX_LENGTH } from "@rome/api-types/trace-segments";
import { useTranslation } from "react-i18next";
import { turnApiPath } from "@/components/agent-trace/turn-api";
import { BranchingChatBubbleIcon } from "@/components/chat/BranchingChatBubbleIcon";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { placeChatWidget } from "@/pages/free/use-free-cells";
import { emitSessionsChanged } from "@/lib/session-events";

const SUGGESTION_KEYS = [
  "message.branch.suggestions.mermaid",
  "message.branch.suggestions.simplify",
  "message.branch.suggestions.example",
] as const;

/** Opens a one-shot side chat branched from a settled assistant turn. */
export function TurnBranchButton({ sessionId, turnId }: { sessionId: string; turnId: string }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<false | "generic" | "notBranchable">(false);

  const submit = useCallback(
    async (rawPrompt: string) => {
      const nextPrompt = rawPrompt.trim();
      if (!nextPrompt || submitting) return;
      setSubmitting(true);
      setError(false);
      try {
        const res = await fetch(turnApiPath(sessionId, turnId, "forks"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: nextPrompt }),
        });
        if (!res.ok) {
          // A turn with no branch point (a side chat's own first answer is
          // the common case) is a permanent property of that turn, not a
          // transient failure — tell the user what to do instead of
          // suggesting a retry.
          const body = (await res.json().catch(() => null)) as { code?: string } | null;
          setError(body?.code === "turn_not_branchable" ? "notBranchable" : "generic");
          return;
        }
        const body = (await res.json()) as { sessionId: string };
        // The branch is an ordinary chat from its 201 — tell the sidebar and
        // open it as a real chat card beside this conversation.
        emitSessionsChanged();
        placeChatWidget(body.sessionId);
        setPrompt("");
        setOpen(false);
      } catch {
        setError("generic");
      } finally {
        setSubmitting(false);
      }
    },
    [sessionId, submitting, turnId],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) setOpen(nextOpen);
      }}
    >
      <PopoverAnchor asChild>
        <div className="flex items-center">
          <IconButton
            size="sm"
            label={t("message.branch.open")}
            icon={<BranchingChatBubbleIcon />}
            aria-expanded={open}
            disabled={submitting}
            onClick={() => setOpen((current) => !current)}
            className="text-muted-foreground hover:text-foreground"
          />
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{t("message.branch.title")}</PopoverTitle>
          <PopoverDescription>{t("message.branch.description")}</PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-wrap gap-2" aria-label={t("message.branch.suggestionsLabel")}>
          {SUGGESTION_KEYS.map((key) => {
            const suggestion = t(key);
            return (
              <Button
                key={key}
                type="button"
                size="xs"
                variant="outline"
                disabled={submitting}
                onClick={() => void submit(suggestion)}
                className="h-auto min-h-6 whitespace-normal py-1 text-left"
              >
                {suggestion}
              </Button>
            );
          })}
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(prompt);
          }}
        >
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={TURN_BRANCH_PROMPT_MAX_LENGTH}
            rows={3}
            disabled={submitting}
            placeholder={t("message.branch.promptPlaceholder")}
            className="text-aux md:text-aux"
            autoFocus
          />
          <div className="flex items-center justify-between gap-2">
            {error ? (
              <span aria-live="polite" className="text-aux text-destructive">
                {t(
                  error === "notBranchable"
                    ? "message.branch.notBranchable"
                    : "message.branch.submitFailed",
                )}
              </span>
            ) : (
              <span />
            )}
            <Button type="submit" size="sm" disabled={submitting || !prompt.trim()}>
              {submitting ? t("message.branch.submitting") : t("message.branch.submit")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
