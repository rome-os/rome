import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { plainQuote } from "@/components/chat/reply/reply-source";
import { getMessageShare, revokeShare, shareMessage, type ShareSummary } from "@/lib/chat-api";
import { cn } from "@/lib/utils";

/**
 * Whether the surface lets its viewer share a message. The live chat turns it
 * on. A shared chat and a read-only viewer leave it off, so they show no Share.
 */
export const MessageSharingContext = createContext(false);

/** The message as plain reading text: markdown marks dropped, links as their words. */
function previewText(markdown: string): string {
  return plainQuote(markdown.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"));
}

type CardState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "creating" }
  | { kind: "shared"; share: ShareSummary }
  | { kind: "error"; message: "shareLoadFailed" | "shareFailed" | "shareStopFailed" };

/**
 * Share on a message: opens a card that previews the message, says who can
 * see a link, and makes one only on Create link. A message has one live link,
 * so opening the card again shows that link, with Copy and Stop sharing.
 */
export function ShareMessageButton({
  sessionId,
  messageId,
  preview,
  size = "sm",
  className,
}: {
  sessionId: string;
  messageId: string;
  /** The message's text, of which the card shows the first lines. */
  preview: string;
  size?: "xs" | "sm";
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const sharing = useContext(MessageSharingContext);
  const [open, setOpen] = useState(false);
  if (!sharing) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          size={size}
          label={t("message.share")}
          icon={<Share2 />}
          className={cn("text-muted-foreground hover:text-foreground", className)}
        />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={t("message.shareTitle")} className="w-80">
        {open ? (
          <ShareMessageCard sessionId={sessionId} messageId={messageId} preview={preview} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ShareMessageCard({
  sessionId,
  messageId,
  preview,
}: {
  sessionId: string;
  messageId: string;
  preview: string;
}) {
  const { t } = useTranslation("chat");
  const [state, setState] = useState<CardState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMessageShare(sessionId, messageId).then(
      (share) => {
        if (!cancelled) setState(share ? { kind: "shared", share } : { kind: "none" });
      },
      () => {
        if (!cancelled) setState({ kind: "error", message: "shareLoadFailed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, messageId]);

  const create = useCallback(async () => {
    setState({ kind: "creating" });
    try {
      setState({ kind: "shared", share: await shareMessage(sessionId, messageId) });
    } catch {
      setState({ kind: "error", message: "shareFailed" });
    }
  }, [sessionId, messageId]);

  const stop = useCallback(async (share: ShareSummary) => {
    try {
      await revokeShare(share.id);
      setCopied(false);
      setState({ kind: "none" });
    } catch {
      setState({ kind: "error", message: "shareStopFailed" });
    }
  }, []);

  const url = state.kind === "shared" ? `${window.location.origin}${state.share.url}` : "";
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [url]);

  return (
    <>
      <p className="line-clamp-3 break-words text-ui text-foreground">{previewText(preview)}</p>
      <p className="text-aux text-muted-foreground">{t("message.shareAudience")}</p>
      {state.kind === "loading" ? (
        <p className="text-aux text-muted-foreground" aria-live="polite">
          {t("message.shareLoading")}
        </p>
      ) : state.kind === "shared" ? (
        <>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={url}
              aria-label={t("message.shareLink")}
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1"
            />
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? (
                <Check data-icon="inline-start" className="size-4" />
              ) : (
                <Copy data-icon="inline-start" className="size-4" />
              )}
              {copied ? t("message.copied") : t("message.shareCopy")}
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-destructive"
            onClick={() => void stop(state.share)}
          >
            {t("message.shareStop")}
          </Button>
        </>
      ) : (
        <>
          {state.kind === "error" ? (
            <p className="text-aux text-destructive" role="alert">
              {t(`message.${state.message}`)}
            </p>
          ) : null}
          <Button size="sm" onClick={() => void create()} disabled={state.kind === "creating"}>
            {state.kind === "creating" ? t("share.creating") : t("share.create")}
          </Button>
        </>
      )}
    </>
  );
}
