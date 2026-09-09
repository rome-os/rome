import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import { Button } from "@/components/ui/button";

// The live preview and persisted transcript mount different Markdown trees.
// MessageList owns this map so the replacement can recover the same fence state.
export const ChatCodeBlockStateContext = createContext<Map<string, boolean> | null>(null);
export const ChatCodeBlockScopeContext = createContext<string | null>(null);

interface MarkdownNode {
  position?: { start?: { offset?: number } };
}

type ChatCodeBlockProps = ComponentProps<"pre"> & { node?: MarkdownNode };

export function ChatCodeBlock({ children, node }: ChatCodeBlockProps) {
  const { t } = useTranslation("chat");
  const disclosureState = useContext(ChatCodeBlockStateContext);
  const disclosureScope = useContext(ChatCodeBlockScopeContext);
  const fenceOffset = node?.position?.start?.offset;
  const disclosureKey =
    disclosureScope !== null && fenceOffset !== undefined
      ? `${disclosureScope}:${fenceOffset}`
      : null;
  const [open, setOpen] = useState(() =>
    disclosureKey === null ? true : (disclosureState?.get(disclosureKey) ?? true),
  );
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
        onClick={() =>
          setOpen((value) => {
            const next = !value;
            if (disclosureKey !== null) disclosureState?.set(disclosureKey, next);
            return next;
          })
        }
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
