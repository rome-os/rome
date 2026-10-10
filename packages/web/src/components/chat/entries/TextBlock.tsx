import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "@/components/chat/ChatMarkdown";

const COMPACT_TEXT_COLLAPSED_MAX_HEIGHT = 240;
const COMPACT_TEXT_FADE_MASK = "linear-gradient(to bottom, black 70%, transparent 100%)";

export function TextBlock({
  content,
  compact = false,
  disclosureStateKey,
}: {
  content: string;
  compact?: boolean;
  disclosureStateKey?: string;
}) {
  if (!compact) {
    return (
      <Markdown className="text-foreground" compact={false} disclosureStateKey={disclosureStateKey}>
        {content}
      </Markdown>
    );
  }
  return <CompactTextBlock content={content} disclosureStateKey={disclosureStateKey} />;
}

export function CompactTextBlock({
  content,
  disclosureStateKey,
}: {
  content: string;
  disclosureStateKey?: string;
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const markdown = el.firstElementChild;
    const measure = () => setOverflowing(el.scrollHeight > COMPACT_TEXT_COLLAPSED_MAX_HEIGHT + 1);
    measure();
    // The container's own height follows the outer expand control, so only its
    // width is relevant. The Markdown child's height tracks inner disclosures
    // even while the container is capped at its collapsed maximum.
    let lastWidth = el.getBoundingClientRect().width;
    const ro = new ResizeObserver((entries) => {
      let contentChanged = false;
      for (const entry of entries) {
        if (entry.target === markdown) {
          contentChanged = true;
          continue;
        }
        if (entry.target !== el || entry.contentRect.width === lastWidth) continue;
        lastWidth = entry.contentRect.width;
        contentChanged = true;
      }
      if (contentChanged) measure();
    });
    ro.observe(el);
    if (markdown) ro.observe(markdown);
    return () => ro.disconnect();
  }, [content]);

  const collapsed = !expanded && overflowing;

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className="overflow-hidden"
        style={
          collapsed
            ? {
                maxHeight: COMPACT_TEXT_COLLAPSED_MAX_HEIGHT,
                maskImage: COMPACT_TEXT_FADE_MASK,
                WebkitMaskImage: COMPACT_TEXT_FADE_MASK,
              }
            : undefined
        }
      >
        <Markdown className="text-foreground" compact disclosureStateKey={disclosureStateKey}>
          {content}
        </Markdown>
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-aux text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? t("blocks.showLess") : t("blocks.showMore")}
        </button>
      )}
    </div>
  );
}
