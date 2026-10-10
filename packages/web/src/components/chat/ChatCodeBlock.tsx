import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import { CollapsibleCard, CollapsibleSection } from "@/components/chat/CollapsibleCard";

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
  const code = isValidElement<{ className?: string; "data-block"?: string }>(children)
    ? children
    : null;
  const language = /(?:^|\s)language-([^\s]+)/.exec(code?.props.className ?? "")?.[1];
  const isMermaid = language === "mermaid";
  const label = isMermaid ? t("markdown.mermaid") : (language ?? t("markdown.code"));

  return (
    <CollapsibleCard className="min-w-0" data-chat-code-block={isMermaid ? "mermaid" : "code"}>
      <CollapsibleSection
        open={open}
        onOpenChange={(next) => {
          if (disclosureKey !== null) disclosureState?.set(disclosureKey, next);
          setOpen(next);
        }}
        title={<span className="truncate text-aux text-muted-foreground">{label}</span>}
      >
        {/* Streamdown's pre renderer marks its child as block code. Keep that
            contract so unlabelled fences do not become inline code. Mount only
            while open so Mermaid measures a visible canvas after expansion. */}
        {open && (code ? cloneElement(code, { "data-block": "true" }) : children)}
      </CollapsibleSection>
    </CollapsibleCard>
  );
}
