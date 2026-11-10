import { createContext, useCallback, useContext, useState } from "react";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { IconButton } from "@/components/ui/icon-button";
import { shareMessage } from "@/lib/chat-api";
import { cn } from "@/lib/utils";

/**
 * Whether the surface lets its viewer share a message. The live chat turns it
 * on. A shared chat and a read-only viewer leave it off, so they show no Share.
 */
export const MessageSharingContext = createContext(false);

/**
 * Shares one message as a link: the server freezes the message's text into a
 * snapshot on `/share/:token`, and the link goes on the clipboard. Where the
 * clipboard refuses, the toast shows the link instead.
 */
export function ShareMessageButton({
  sessionId,
  messageId,
  onShare,
  size = "sm",
  className,
}: {
  sessionId: string;
  messageId: string;
  /** Called once the link is made, e.g. to close the row holding the button. */
  onShare?: () => void;
  size?: "xs" | "sm";
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const sharing = useContext(MessageSharingContext);
  const [busy, setBusy] = useState(false);

  const handleShare = useCallback(async () => {
    setBusy(true);
    try {
      const result = await shareMessage(sessionId, messageId);
      const url = `${window.location.origin}${result.url}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success(t("message.shareCopied"));
      } catch {
        toast(t("message.shareReady"), { description: url });
      }
      onShare?.();
    } catch {
      toast.error(t("message.shareFailed"));
    } finally {
      setBusy(false);
    }
  }, [sessionId, messageId, onShare, t]);

  if (!sharing) return null;
  return (
    <IconButton
      size={size}
      label={t("message.share")}
      icon={<Share2 />}
      disabled={busy}
      onClick={() => void handleShare()}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    />
  );
}
