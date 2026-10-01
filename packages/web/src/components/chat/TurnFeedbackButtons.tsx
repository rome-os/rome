import { useCallback, useEffect, useRef, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  TURN_FEEDBACK_COMMENT_MAX_LENGTH,
  type TurnFeedback,
  type TurnFeedbackRating,
} from "@rome/api-types/trace-segments";
import { turnApiPath } from "@/components/agent-trace/turn-api";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { autoPlaceApp } from "@/pages/free/use-free-cells";

// Inline turn feedback: thumbs up/down icon buttons that sit in the same
// action row as the copy button under an agent turn. Either thumb opens a
// small popover with an optional comment before submitting. Each turn gets
// exactly one feedback record (the server answers 409 once a record exists),
// so after submit the buttons lock with the recorded rating shown.
export function TurnFeedbackButtons({ sessionId, turnId }: { sessionId: string; turnId: string }) {
  const { t } = useTranslation("chat");
  // The recorded rating (submitted now, or hydrated from an existing record).
  const [rating, setRating] = useState<TurnFeedbackRating | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);
  // Draft: the comment popover is open for this rating, nothing submitted yet.
  const [draftRating, setDraftRating] = useState<TurnFeedbackRating | null>(null);
  const [comment, setComment] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Lazy hydration: one GET per turn, deferred until the row scrolls into
  // view so a long transcript doesn't fan out a request per turn on mount.
  // A hydrate failure is non-fatal — the POST's 409 path re-syncs with any
  // record the server already holds.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      (async () => {
        try {
          const res = await fetch(turnApiPath(sessionId, turnId, "feedback"), {
            credentials: "include",
          });
          if (cancelled || !res.ok) return;
          const body = (await res.json()) as { feedback: TurnFeedback | null };
          if (cancelled || !body.feedback) return;
          setRating(body.feedback.rating);
          setSubmitted(true);
        } catch {
          // Ignore — the submit path handles an existing record via 409.
        }
      })();
    });
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [sessionId, turnId]);

  const submit = useCallback(
    async (nextRating: TurnFeedbackRating, nextComment: string) => {
      setSubmitting(true);
      setError(false);
      try {
        const res = await fetch(turnApiPath(sessionId, turnId, "feedback"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: nextRating, comment: nextComment }),
        });
        if (res.ok) {
          const body = (await res.json()) as {
            feedback: TurnFeedback;
            processing?: { appId: string; route: string };
          };
          setRating(nextRating);
          setSubmitted(true);
          setDraftRating(null);
          if (body.processing) {
            autoPlaceApp(body.processing.appId, body.processing.route, undefined, true);
          }
        } else if (res.status === 409) {
          // Another surface beat us to it — adopt the server's record and lock.
          try {
            const body = (await res.json()) as { feedback: TurnFeedback | null };
            if (body.feedback) setRating(body.feedback.rating);
          } catch {
            // Body parse failed; still locked since the server says so.
          }
          setSubmitted(true);
          setDraftRating(null);
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      } finally {
        setSubmitting(false);
      }
    },
    [sessionId, turnId],
  );

  const locked = submitted;
  const upActive = (rating === "positive" && locked) || draftRating === "positive";
  const downActive = (rating === "negative" && locked) || draftRating === "negative";

  const toggleDraft = (nextRating: TurnFeedbackRating) => {
    setComment("");
    setDraftRating((current) => (current === nextRating ? null : nextRating));
  };

  return (
    <Popover
      open={draftRating !== null}
      onOpenChange={(open) => {
        if (!open) setDraftRating(null);
      }}
    >
      <PopoverAnchor asChild>
        <div ref={containerRef} className="flex items-center">
          <IconButton
            size="sm"
            label={locked ? t("message.feedback.recorded") : t("message.feedback.thumbsUp")}
            icon={<ThumbsUp className={cn(upActive && "fill-current")} />}
            aria-pressed={upActive}
            disabled={locked || submitting}
            onClick={() => toggleDraft("positive")}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              upActive && "text-foreground disabled:opacity-100",
            )}
          />
          <IconButton
            size="sm"
            label={locked ? t("message.feedback.recorded") : t("message.feedback.thumbsDown")}
            icon={<ThumbsDown className={cn(downActive && "fill-current")} />}
            aria-pressed={downActive}
            disabled={locked || submitting}
            onClick={() => toggleDraft("negative")}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              downActive && "text-foreground disabled:opacity-100",
            )}
          />
          {error && (
            <span aria-live="polite" className="ml-1 text-aux text-destructive">
              {t("message.feedback.submitFailed")}
            </span>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-80">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={TURN_FEEDBACK_COMMENT_MAX_LENGTH}
          rows={2}
          disabled={submitting}
          placeholder={t("message.feedback.commentPlaceholder")}
          className="text-aux md:text-aux"
          autoFocus
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={submitting}
            onClick={() => {
              if (draftRating) void submit(draftRating, comment);
            }}
          >
            {submitting ? t("message.feedback.submitting") : t("message.feedback.submit")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
