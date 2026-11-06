import { EnterIcon } from "@radix-ui/react-icons";
import { CollapsibleTraceRow } from "@/components/agent-trace/CollapsibleTraceRow";

/**
 * What a system turn was handed, such as the lines the Concierge got for its
 * following, under the label its caller gave. Collapsed by default: it is the
 * turn's input, kept in the trace, never a message in the chat.
 */
export function SystemInputView({ label, content }: { label: string; content: string }) {
  return (
    <CollapsibleTraceRow
      icon={<EnterIcon />}
      label={label}
      bodyClassName="flex flex-col gap-3 pt-1 pr-3 pb-3 pl-9"
    >
      <pre
        data-system-input
        className="m-0 whitespace-pre-wrap break-words font-mono text-aux text-foreground"
      >
        {content}
      </pre>
    </CollapsibleTraceRow>
  );
}
