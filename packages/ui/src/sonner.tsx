import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps as SonnerToasterProps } from "sonner";
import "./style-modules.js";
import "sonner/dist/styles.css";
import { cn } from "./cn.js";

const toastClassName =
  "group toast flex w-[var(--width)] items-center gap-2 rounded-8 border border-border bg-surface-elevated p-4 text-foreground shadow-4 outline-none focus-visible:shadow-4! outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 data-[expanded=false]:data-[front=false]:[&>*]:opacity-0";
const titleClassName = "text-badge";
const descriptionClassName = "text-aux text-muted-foreground";
const contentClassName = "flex flex-col gap-1";
// The slot takes its width from the glyph rather than a pinned `size-4`, for
// the same reason Alert's icon column is `auto`: the rule below lets a caller's
// `icons` glyph opt out of the 16px, and a slot fixed at the default would let
// a larger one eat the gap and run under the title.
const iconClassName =
  "flex shrink-0 items-center justify-start [&_svg:not([class*='size-'])]:size-4";
const controlClassName =
  "inline-flex h-6 shrink-0 items-center justify-center rounded-[var(--control-r-sm)] border border-transparent px-2 text-badge outline-none transition-colors outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 disabled:cursor-not-allowed disabled:opacity-50";
const actionButtonClassName = `ms-auto bg-primary text-primary-foreground hover:bg-primary/80 ${controlClassName}`;
const cancelButtonClassName = `ms-auto bg-surface-muted text-muted-foreground hover:bg-surface-hover hover:text-foreground ${controlClassName}`;
const closeButtonClassName =
  "absolute top-0 start-[var(--toast-close-button-start)] end-[var(--toast-close-button-end)] z-1 flex size-5 items-center justify-center rounded-full border border-border bg-surface-elevated p-0 text-foreground [transform:var(--toast-close-button-transform)] transition-colors hover:bg-surface-hover outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50";

export type ToasterProps = Omit<SonnerToasterProps, "theme" | "richColors">;

export function Toaster({ className, icons, style, toastOptions, ...props }: ToasterProps) {
  return (
    <Sonner
      {...props}
      className={cn("toaster group", className)}
      // Theme and rich-color modes only select Sonner's painted CSS. Rome's
      // semantic tokens already follow the host theme, so keep those modes off.
      theme="light"
      richColors={false}
      // The status glyphs carry no size: the icon slot sets it, so a caller
      // replacing one through `icons` lands on the same step without knowing
      // it. `close` rides the close button instead of that slot, so it keeps
      // its own.
      icons={{
        success: <CircleCheckIcon />,
        info: <InfoIcon />,
        warning: <TriangleAlertIcon />,
        error: <OctagonXIcon />,
        loading: <Loader2Icon className="animate-spin" />,
        close: <XIcon className="size-3" />,
        ...icons,
      }}
      style={style}
      toastOptions={{
        ...toastOptions,
        // Sonner still owns positioning, stacking, swiping, and motion. Rome
        // owns every visual decision below, so its painted defaults stay off.
        unstyled: true,
        classNames: {
          ...toastOptions?.classNames,
          toast: cn(toastClassName, toastOptions?.classNames?.toast),
          title: cn(titleClassName, toastOptions?.classNames?.title),
          description: cn(descriptionClassName, toastOptions?.classNames?.description),
          content: cn(contentClassName, toastOptions?.classNames?.content),
          icon: cn(iconClassName, toastOptions?.classNames?.icon),
          actionButton: cn(actionButtonClassName, toastOptions?.classNames?.actionButton),
          cancelButton: cn(cancelButtonClassName, toastOptions?.classNames?.cancelButton),
          closeButton: cn(closeButtonClassName, toastOptions?.classNames?.closeButton),
        },
      }}
    />
  );
}
