import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "./cn.js";
import { InputGlyph, inputVariants } from "./input.js";

// shadcn Command (cmdk) rewired to the semantic token set. The Dialog variant
// is intentionally omitted — Rome composes Command inside Popover (combobox)
// or its own Dialog primitive at the call site.

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-8 bg-popover text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Command's root turns every bubbling Enter into "activate the highlighted
 * item" and calls preventDefault, which cancels the native activation of any
 * focused control that is not a CommandItem. Put this on such a control — a
 * clear button, a retry button — so its own Enter survives. Only Enter is held
 * back, so the arrow keys still reach the list and it stays navigable.
 */
export function stopEnterPropagation(event: React.KeyboardEvent): void {
  if (event.key === "Enter") event.stopPropagation();
}

// `children` render as trailing content in the field row (a clear button, a
// shortcut hint) rather than reaching the input, which is a void element.
type CommandInputProps = React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** Classes for the actual text field inside the Control wrapper. */
  inputClassName?: string;
};

function CommandInput({
  className,
  inputClassName,
  children,
  onKeyDown,
  ...props
}: CommandInputProps) {
  return (
    <div
      // The row is a `plain` Input inside a header: the field paints no border
      // or radius of its own, and the row's bottom rule is what reads the
      // header against the list. The glyph takes the seat `Input` gives one.
      //
      // No focus edge, for two reasons that hold independently. The row is a
      // full-bleed header inside Command's `overflow-hidden`, so an edge is
      // clipped on three sides; and cmdk holds focus in this input for the
      // life of the surface, so an edge keyed to it stays lit and marks
      // nothing. The `plain` variant keeps the edge; this caller turns it off.
      // Role and divergence: docs/ui/component-roles.md.
      data-slot="command-input-wrapper"
      className={cn("relative flex items-center border-b border-border", className)}
    >
      <InputGlyph size="md">
        <Search aria-hidden />
      </InputGlyph>
      <CommandPrimitive.Input
        data-slot="command-input"
        data-size="md"
        data-variant="plain"
        className={cn(
          inputVariants({ size: "md", variant: "plain", hasIcon: true }),
          "focus-visible:outline-transparent",
          inputClassName,
        )}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          // Command's root binds Home/End to "jump to the first/last item" and
          // preventDefaults them, which takes them away from the caret. This is
          // an editable combobox, where those keys belong to the text field.
          if (event.key === "Home" || event.key === "End") event.stopPropagation();
        }}
        {...props}
      />
      {children ? (
        // Because only Enter is held back, the arrow keys still reach the list
        // and it stays navigable from here. That makes this slot suitable for
        // simple controls — a clear button, a shortcut hint — and unsuitable
        // for one that needs ArrowUp/Down/Home/End for its own navigation,
        // which the list would take instead.
        <div
          data-slot="command-input-trailing"
          // Sits at the row's own inset: the field pads itself, so the trailing
          // slot has to take the same start-group step on its outer side.
          className="mr-[var(--control-px-start-md)] flex shrink-0 items-center gap-2"
          onKeyDown={stopEnterPropagation}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-72 overflow-x-hidden overflow-y-auto", className)}
      {...props}
    />
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-ui text-muted-foreground"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-aux [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-8 px-2 py-1 text-ui outline-hidden select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
};
