import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu.js";
import { Dialog, DialogBody } from "./dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js";
import { Sheet } from "./sheet.js";
import { mountShadowApp } from "./test/shadow-app.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.js";

// Unmount React roots before wiping the shadow hosts these tests append
// directly to document.body.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/**
 * Every member of the floating family, rendered open, plus the selector that
 * finds the layer it portals. Each is opened through its `open` prop where it
 * has one — what's under test is where the layer lands, not how it is
 * triggered. `open` on a ContextMenu is the one exception Radix warns about
 * (it can't anchor a menu that no pointer opened), so that one uses the
 * gesture.
 */
const FLOATING: Array<{
  name: string;
  selector: string;
  element: () => ReactElement;
  open?: (root: ParentNode) => void;
}> = [
  {
    name: "Dialog",
    selector: "[role=dialog]",
    element: () => (
      <Dialog open onClose={() => {}} ariaLabel="dialog">
        <DialogBody>body</DialogBody>
      </Dialog>
    ),
  },
  {
    name: "Sheet",
    selector: "[role=dialog]",
    element: () => (
      <Sheet open onClose={() => {}} ariaLabel="sheet">
        panel
      </Sheet>
    ),
  },
  {
    name: "Popover",
    selector: "[data-slot=popover-content]",
    element: () => (
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent>content</PopoverContent>
      </Popover>
    ),
  },
  {
    name: "DropdownMenu",
    selector: "[data-slot=dropdown-menu-content]",
    element: () => (
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  {
    name: "ContextMenu",
    selector: "[data-slot=context-menu-content]",
    element: () => (
      <ContextMenu>
        <ContextMenuTrigger>target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>item</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ),
    open: (root) => {
      const trigger = root.querySelector("[data-slot=context-menu-trigger]");
      if (!trigger) throw new Error("context menu trigger not found");
      fireEvent.contextMenu(trigger);
    },
  },
  {
    name: "Tooltip",
    selector: "[data-slot=tooltip-content]",
    element: () => (
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>hover</TooltipTrigger>
          <TooltipContent>tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ),
  },
  {
    name: "Select",
    selector: "[data-slot=select-content]",
    element: () => (
      <Select open>
        <SelectTrigger>
          <SelectValue placeholder="pick" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">a</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
];

describe.each(FLOATING)("$name", ({ selector, element, open }) => {
  it("keeps its floating layer inside the app's shadow root, under the theme scope", () => {
    const { shadowRoot, appBody, mountRoot } = mountShadowApp();
    appBody.classList.add("dark");

    render(element(), { container: mountRoot });
    open?.(mountRoot);

    const layer = shadowRoot.querySelector(selector);
    expect(layer).not.toBeNull();
    // Outside the theme-carrying <body> every `dark:` variant would paint light.
    expect(appBody.contains(layer)).toBe(true);
    expect(document.body.querySelector(selector)).toBeNull();
  });

  it("portals to document.body when rendered in the plain document", () => {
    const { container } = render(element());
    open?.(container);

    const layer = document.body.querySelector(selector);
    expect(layer).not.toBeNull();
    // Escaping the render tree is the point — it clears any clipping or
    // stacking context an ancestor imposes.
    expect(container.contains(layer)).toBe(false);
  });
});
