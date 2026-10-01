import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

// Under-message copy affordance: copies the turn's raw text (the markdown
// source, not the rendered HTML). Swaps to a check for a beat as feedback,
// mirroring ShareBar's copy timing.
export function CopyMessageButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [text]);

  return (
    <IconButton
      size="sm"
      label={copied ? t("message.copied", "Copied") : t("message.copy", "Copy message")}
      icon={copied ? <Check /> : <Copy />}
      onClick={handleCopy}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    />
  );
}
