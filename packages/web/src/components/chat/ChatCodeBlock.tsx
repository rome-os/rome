import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import { ChatPictureSet } from "@/components/chat/ChatPictureSet";
import { CollapsibleCard, CollapsibleSection } from "@/components/chat/CollapsibleCard";
import { fenceBodyLines, parsePictureSet } from "@/lib/picture-set";

// The live preview and persisted transcript mount different Markdown trees.
// MessageList owns this map so the replacement can recover the same fence state.
export const ChatCodeBlockStateContext = createContext<Map<string, boolean> | null>(null);
export const ChatCodeBlockScopeContext = createContext<string | null>(null);

interface MarkdownNode {
  position?: { start?: { offset?: number; line?: number }; end?: { line?: number } };
}

type ChatCodeBlockProps = ComponentProps<"pre"> & { node?: MarkdownNode };

/**
 * Whether the last line of a fence's body has ended. A fence that is still
 * streaming can stop partway through a line. Every line of the body follows a
 * newline, so a block that spans more newlines than the body has lines holds
 * one after the last: the closing fence, or the end of that line. Without the
 * block's position, every line counts as ended.
 */
function fenceLinesEnded(node: MarkdownNode | undefined, body: string): boolean {
  const start = node?.position?.start?.line;
  const end = node?.position?.end?.line;
  if (start === undefined || end === undefined) return true;
  return end - start > fenceBodyLines(body).length;
}

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
  const code = isValidElement<{
    className?: string;
    "data-block"?: string;
    metastring?: string;
    children?: unknown;
  }>(children)
    ? children
    : null;
  const language = /(?:^|\s)language-([^\s]+)/.exec(code?.props.className ?? "")?.[1];
  // A `pictures` fence is a set of pictures in a reply. One with no safe
  // picture stays a code block.
  const pictureSet =
    language === "pictures" && typeof code?.props.children === "string"
      ? parsePictureSet(code.props.children, {
          meta: code.props.metastring,
          complete: fenceLinesEnded(node, code.props.children),
        })
      : null;
  const isMermaid = language === "mermaid";
  const label = isMermaid ? t("markdown.mermaid") : (language ?? t("markdown.code"));

  if (pictureSet) return <ChatPictureSet set={pictureSet} />;

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
