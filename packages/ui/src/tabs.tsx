import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "./cn.js";

/**
 * Underline tabs: a transparent track where the active trigger grows a 2px
 * foreground bar along its edge. Each tab owns a `TabsContent` panel.
 *
 * For a control that switches or filters a single view — no panel per choice —
 * use `SegmentedControl`, which is where the segmented treatment now lives.
 */
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "group/tabs-list inline-flex w-fit items-center justify-center gap-1 bg-transparent p-1 text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // The label is centred, so the padding is the `center` group's. Which
        // step is a judgement call rather than a lookup: the list is 32px,
        // between the two shared heights, so the trigger names no size and
        // takes the smaller step — recorded as a divergence in
        // `docs/ui/component-roles.md` rather than passed off as a fit. The
        // glyph follows that same judgement to the same step, so the trigger
        // does not pad at `sm` while sizing its icon at `md`.
        "relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-2 rounded-8 border border-transparent bg-transparent px-[var(--control-px-center-sm)] py-1 text-ui whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        "data-active:bg-transparent data-active:text-foreground",
        // The underline itself: a 2px foreground border that fades in on the
        // active trigger — below it when horizontal, beside it when vertical.
        // Drawn as a border on a zero-content pseudo-element, not a sized box,
        // so it authors no off-scale edge length.
        "after:absolute after:border-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:border-b-2 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:border-r-2 data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      // No typography role: the panel is a container, and whatever it holds
      // declares its own. A role here would size every undeclared descendant
      // from the panel rather than from the surface author's choice.
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
