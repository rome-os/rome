import { cloneElement, isValidElement, useId, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import { Button } from "@/components/ui/button";

export function ChatCodeBlock({ children }: ComponentProps<"pre">) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const code = isValidElement<{ className?: string; "data-block"?: string }>(children)
    ? children
    : null;
  const language = /(?:^|\s)language-([^\s]+)/.exec(code?.props.className ?? "")?.[1];
  const isMermaid = language === "mermaid";
  const label = isMermaid ? t("markdown.mermaid") : (language ?? t("markdown.code"));

  return (
    <div className="min-w-0" data-chat-code-block={isMermaid ? "mermaid" : "code"}>
      <Button
        variant="ghost"
        size="sm"
        align="start"
        className="w-full text-muted-foreground"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon aria-hidden="true" className={open ? "rotate-90" : ""} />
        <span className="truncate">{label}</span>
      </Button>
      <div id={bodyId} hidden={!open} data-chat-code-block-body="">
        {/* Streamdown's pre renderer marks its child as block code. Keep that
            contract so unlabelled fences do not become inline code. Mount only
            while open so Mermaid measures a visible canvas after expansion. */}
        {open && (code ? cloneElement(code, { "data-block": "true" }) : children)}
      </div>
    </div>
  );
}
