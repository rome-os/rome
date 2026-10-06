import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import Markdown from "@/components/chat/ChatMarkdown";

/**
 * Strip the inline-emphasis markers that show up in agent thinking blocks
 * (`**bold**`, `*em*`, `_em_`, ``inline code``, `~~strike~~`). The preview is a
 * single truncated line where rendering markdown wouldn't help and literal
 * `**` markers look broken (Codex emits headings like `**Considering …**`).
 */
export function stripPreviewMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

export function getThinkingBlockPreview(content: string, fallback: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return fallback;
  const stripped = stripPreviewMarkdown(firstLine);
  return stripped || fallback;
}

export function ThinkingBlock({ content }: { content: string }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const body = content?.trim() ?? "";
  const label = getThinkingBlockPreview(content, t("blocks.thinking"));
  const hasBody = body.length > 0;

  return (
    <div data-open={open} className="my-1 rounded-8">
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        disabled={!hasBody}
        className={`flex w-full select-text items-center gap-2 rounded-8 py-2 pr-2 pl-3 text-left ${
          hasBody ? "hover:bg-surface-muted/70" : "cursor-default"
        }`}
      >
        {hasBody ? (
          <ChevronRightIcon
            className={`ml-3 h-3 w-3 flex-none text-subtle-foreground transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
        ) : (
          <span
            aria-hidden="true"
            className="ml-4 mr-1 inline-block h-1 w-1 flex-none rounded-full bg-subtle-foreground"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-aux italic text-muted-foreground">
          {label}
        </span>
      </button>
      {open && hasBody && (
        <div className="pt-1 pr-3 pb-2 pl-9">
          <div className="rounded-8 border border-border bg-surface-muted px-3 py-2 italic text-muted-foreground">
            <Markdown className="text-muted-foreground" compact preserveSoftBreaks>
              {body}
            </Markdown>
          </div>
        </div>
      )}
    </div>
  );
}
