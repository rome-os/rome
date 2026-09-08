import type { ComponentProps } from "react";
import Markdown from "@/components/markdown";
import { ChatLink } from "./ChatLink";
import { ChatCodeBlock } from "./ChatCodeBlock";

// Chat links open in the workspace, and fenced blocks can be collapsed.
// Chat blocks import this instead of `@/components/markdown`.
export default function ChatMarkdown(props: ComponentProps<typeof Markdown>) {
  return <Markdown {...props} linkComponent={ChatLink} preComponent={ChatCodeBlock} />;
}
