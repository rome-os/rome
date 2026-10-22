import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChatGPTIcon, META_LOGO_SRC } from "@/components/brand-icons/ai-tool-icons";
import { RomeLogo } from "@/components/logo";
import { cn } from "@/lib/utils";

/** The name for an assistant's kind. A kind this dashboard does not know yet is
 *  shown as Rome Cloud spells it. */
export function useAssistantKindLabel(): (kind: string) => string {
  const { t } = useTranslation("common");
  return (kind) => t(`assistants.kind.${kind}`, { defaultValue: kind });
}

// Inline rather than a utility class: the stylesheet build resolves any
// `url()` it finds in the sources as a module, and the file is served from
// `public/` instead.
const META_MASK = {
  maskImage: `url(${META_LOGO_SRC})`,
  maskPosition: "center",
  maskSize: "contain",
  maskRepeat: "no-repeat",
} as const;

/**
 * The product's logo for an assistant's kind, in the current text color. The
 * same marks Rome Cloud's Settings draws, from the files this dashboard
 * already ships: ChatGPT for a Dot, Meta's for Muse, which has no mark of its
 * own, and Rome's. A kind this dashboard has no mark for gets a generic one.
 */
export function AssistantKindMark({ kind, className }: { kind: string; className?: string }) {
  if (kind === "dot")
    return <ChatGPTIcon aria-hidden="true" role={undefined} className={className} />;
  if (kind === "rome") return <RomeLogo aria-hidden className={className} />;
  if (kind === "muse") {
    // The provider logo file, painted through a mask so it takes the text
    // color in both themes instead of the file's own black.
    return (
      <span
        aria-hidden="true"
        className={cn("inline-block bg-current", className)}
        style={META_MASK}
      />
    );
  }
  return <Bot aria-hidden="true" className={className} />;
}

/**
 * Marks an assistant's kind in front of its name: the product's logo, named
 * for screen readers and on hover. A name can be anything its owner chose, so
 * the mark keeps the kind clear without repeating it as text.
 */
export function AssistantKindIcon({
  kind,
  className = "size-3.5",
}: {
  kind: string;
  className?: string;
}) {
  const label = useAssistantKindLabel()(kind);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center text-muted-foreground"
    >
      <AssistantKindMark kind={kind} className={className} />
    </span>
  );
}
