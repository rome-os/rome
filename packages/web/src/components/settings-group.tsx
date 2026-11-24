import { Section, SectionHeader, SectionTitle } from "@rome-os/ui/page";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsGroupProps extends Omit<ComponentProps<typeof Section>, "title"> {
  /** Group label seated above the inset surface, aligned to its 16px row inset. */
  title: ReactNode;
  /** Optional id for the heading when a caller links `aria-labelledby` explicitly. */
  titleId?: string;
}

/**
 * A titled group of settings rows or cards.
 *
 * Aligns the group heading to the 16px text inset of `FormRow` and `Card`
 * (`px-4`), renders it in the quieter `text-aux` group-header role in muted
 * ink, and seats it 8px (`gap-2`) above its surface — matching the native iOS
 * `SettingsGroup` layout.
 */
export function SettingsGroup({
  title,
  titleId,
  className,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: SettingsGroupProps) {
  const generatedId = useId();
  const headingId = titleId ?? generatedId;

  return (
    <Section
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? ariaLabelledBy : (ariaLabelledBy ?? headingId)}
      className={cn("gap-2", className)}
      {...props}
    >
      <SectionHeader className="px-4">
        <SectionTitle id={headingId} className="text-aux text-muted-foreground">
          {title}
        </SectionTitle>
      </SectionHeader>
      {children}
    </Section>
  );
}

/**
 * Explanatory note seated below a settings group surface, aligned to the same
 * 16px text inset as the group heading and rows.
 */
export function SettingsGroupFooter({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="settings-group-footer"
      className={cn("px-4 text-aux [text-wrap-style:pretty] text-muted-foreground", className)}
      {...props}
    />
  );
}
