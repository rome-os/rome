import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import Markdown from "@/components/markdown";
import { cn } from "@/lib/utils";
import { ChatLink } from "./ChatLink";
import { ChatCodeBlock, ChatCodeBlockScopeContext } from "./ChatCodeBlock";

type ChatMarkdownProps = ComponentProps<typeof Markdown> & { disclosureStateKey?: string };

type ChatInlineCodeProps = ComponentPropsWithoutRef<"code"> & { node?: unknown };

const HEX_COLOR_LITERAL = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

function ChatInlineCode({ children, className, node: _node, ...props }: ChatInlineCodeProps) {
  const color = typeof children === "string" && HEX_COLOR_LITERAL.test(children) ? children : null;

  return (
    <code
      {...props}
      className={cn("rounded-4 bg-muted font-mono", className)}
      data-streamdown="inline-code"
    >
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

// Chat links open in the workspace, and fenced blocks can be collapsed.
// Chat blocks import this instead of `@/components/markdown`.
export default function ChatMarkdown({ disclosureStateKey, ...props }: ChatMarkdownProps) {
  return (
    <ChatCodeBlockScopeContext.Provider value={disclosureStateKey ?? null}>
      <Markdown
        key={disclosureStateKey}
        {...props}
        inlineCodeComponent={ChatInlineCode}
        linkComponent={ChatLink}
        preComponent={ChatCodeBlock}
      />
    </ChatCodeBlockScopeContext.Provider>
  );
}
