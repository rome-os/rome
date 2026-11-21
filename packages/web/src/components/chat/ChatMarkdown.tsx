import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import Markdown from "@/components/markdown";
import { cn } from "@/lib/utils";
import { ChatLink } from "./ChatLink";
import { ChatCodeBlock, ChatCodeBlockScopeContext } from "./ChatCodeBlock";
import { ChatImage } from "./ChatImage";

type ChatMarkdownProps = ComponentProps<typeof Markdown> & { disclosureStateKey?: string };

type ChatInlineCodeProps = ComponentPropsWithoutRef<"code"> & { node?: unknown };

const HEX_COLOR_LITERAL = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

function ChatInlineCode({ children, className, node: _node, ...props }: ChatInlineCodeProps) {
  const color = typeof children === "string" && HEX_COLOR_LITERAL.test(children) ? children : null;

  return (
    <code {...props} className={cn("font-mono", className)} data-streamdown="inline-code">
      {children}
      {color ? (
        <span
          aria-hidden="true"
          className="ml-1 inline-block size-3 rounded-4 border border-border-strong align-middle"
          data-chat-color-preview={color}
          style={{ backgroundColor: color }}
        />
      ) : null}
    </code>
  );
}

/**
 * The text of a chat message, wherever one renders: in a bubble, as a bare
 * final answer, in a thread, or on a share page. It sets the kit's message
 * type (`.rome-markdown-message`: small headings, a loose line, and blocks
 * one body size apart); Markdown that is not a message keeps the kit's default. Chat links
 * open in the workspace, and fenced blocks can be collapsed. Chat entries
 * import this instead of `@/components/markdown`.
 */
export default function ChatMarkdown({
  disclosureStateKey,
  className,
  ...props
}: ChatMarkdownProps) {
  return (
    <ChatCodeBlockScopeContext.Provider value={disclosureStateKey ?? null}>
      <Markdown
        key={disclosureStateKey}
        {...props}
        className={cn("rome-markdown-message", className)}
        imageComponent={ChatImage}
        inlineCodeComponent={ChatInlineCode}
        linkComponent={ChatLink}
        preComponent={ChatCodeBlock}
      />
    </ChatCodeBlockScopeContext.Provider>
  );
}
