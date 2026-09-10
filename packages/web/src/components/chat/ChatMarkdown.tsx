import type { ComponentProps } from "react";
import Markdown from "@/components/markdown";
import { ChatLink } from "./ChatLink";
import { ChatCodeBlock, ChatCodeBlockScopeContext } from "./ChatCodeBlock";

type ChatMarkdownProps = ComponentProps<typeof Markdown> & { disclosureStateKey?: string };

// Chat links open in the workspace, and fenced blocks can be collapsed.
// Chat blocks import this instead of `@/components/markdown`.
export default function ChatMarkdown({ disclosureStateKey, ...props }: ChatMarkdownProps) {
  return (
    <ChatCodeBlockScopeContext.Provider value={disclosureStateKey ?? null}>
      <Markdown
        key={disclosureStateKey}
        {...props}
        linkComponent={ChatLink}
        preComponent={ChatCodeBlock}
      />
    </ChatCodeBlockScopeContext.Provider>
  );
}
