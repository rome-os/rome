import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleRightIcon } from "@radix-ui/react-icons";
import { describeBashCall } from "@/lib/bash-call-label";
import { artifactLocalName } from "@/lib/artifact-name";
import { TracePayloadView } from "./TracePayload";

export function ToolUseBlock({ tool, input }: { tool?: string; input: unknown }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const toolLabel = artifactLocalName(tool ?? t("blocks.unknownTool"));
  const actionLabel = tool === "Bash" ? describeBashCall(input, "inProgress") : null;
  const header = actionLabel ?? t("blocks.usingTool", { tool: toolLabel });
  return (
    <div className="mb-2 rounded-4 border border-info-border bg-info-bg">
      <button
        className="flex w-full select-text items-start gap-2 px-3 py-2 text-left text-aux text-info-fg hover:bg-info-bg"
        onClick={() => setOpen(!open)}
      >
        <TriangleRightIcon className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 break-words">{header}</span>
      </button>
      {open && (
        <div className="border-t border-info-border px-3 py-2 text-aux text-info-fg">
          <TracePayloadView value={input} />
        </div>
      )}
    </div>
  );
}
