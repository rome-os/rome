import { File as FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A file shown in chat as a compact chip: a link to the stored file that saves
 * it under its own name (`download`). Every file is saved, a pdf too, so the
 * desktop app's authenticated session handles it like any other file.
 */
export function FileChip({
  href,
  label,
  className,
  onOpen,
}: {
  href: string;
  label: string;
  className?: string;
  /**
   * Takes a plain click instead of saving the file, when it answers true.
   * A modified or middle click still saves or opens it as a link does.
   */
  onOpen?: () => boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      download={label}
      onClick={(event) => {
        if (
          !onOpen ||
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        )
          return;
        if (onOpen()) event.preventDefault();
      }}
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-8 border border-border bg-muted px-2 py-1 align-middle text-ui text-foreground !no-underline outline-1 outline-offset-0 outline-transparent hover:border-border-strong focus-visible:outline-solid focus-visible:outline-ring/50",
        className,
      )}
    >
      <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </a>
  );
}
