import { useState } from "react";
import { Archive, Copy, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Component, Row, Section, Specimen } from "../kit";

export function OverlaysSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <Section
      id="overlays"
      title="Overlays"
      description="Anything that portals out of the document flow. Each one traps focus and closes on ESC — click through them here rather than guessing."
    >
      <Component id="dialog" name="Dialog" source="ui/dialog.tsx">
        <Specimen
          label="Dialog"
          note="Radix Dialog with a scrim; `modal` disables ESC and backdrop close."
        >
          <Row>
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              Open dialog
            </Button>
          </Row>
          <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} size="sm">
            <DialogHeader>
              <DialogTitle>Uninstall the bookkeeper?</DialogTitle>
              <DialogDescription>
                Its ledger stays on disk. You can reinstall it later and pick up where it left off.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <p className="text-ui text-foreground">
                Twelve routines reference this app. They'll stop running until it's back.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Keep it
              </Button>
              <Button variant="destructive" onClick={() => setDialogOpen(false)}>
                <Trash2 data-icon="inline-start" />
                Uninstall
              </Button>
            </DialogFooter>
          </Dialog>
        </Specimen>
      </Component>

      <Component id="sheet" name="Sheet" source="ui/sheet.tsx">
        <Specimen label="Sheet" note="Right-side slide-in panel, same Radix Dialog underneath.">
          <Row>
            <Button variant="outline" onClick={() => setSheetOpen(true)}>
              Open sheet
            </Button>
          </Row>
          <Sheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            widthClassName="w-full max-w-xl"
          >
            <div className="border-b border-border px-6 py-4">
              <SheetTitle>App store</SheetTitle>
              <SheetDescription>Browse apps you can hire for the business.</SheetDescription>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <p className="text-ui text-muted-foreground">Panel body.</p>
            </div>
            <div className="border-t border-border px-6 py-4">
              <Button variant="ghost" onClick={() => setSheetOpen(false)}>
                Close
              </Button>
            </div>
          </Sheet>
        </Specimen>
      </Component>

      <Component id="popover" name="Popover" source="ui/popover.tsx">
        <Specimen label="Popover">
          <Row>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Show details</Button>
              </PopoverTrigger>
              <PopoverContent className="w-72">
                <PopoverHeader>
                  <PopoverTitle>Session ses_01J9Z4</PopoverTitle>
                  <PopoverDescription>Started 09:02, finished 09:03.</PopoverDescription>
                </PopoverHeader>
              </PopoverContent>
            </Popover>
          </Row>
        </Specimen>
      </Component>

      <Component id="dropdown-menu" name="DropdownMenu" source="ui/dropdown-menu.tsx">
        <Specimen label="DropdownMenu" note="Sizes to its content, not the trigger.">
          <Row>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-md" aria-label="Row actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Session</DropdownMenuLabel>
                <DropdownMenuItem>
                  <Copy />
                  Copy ID
                  <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Archive />
                  Archive
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Row>
        </Specimen>
      </Component>

      <Component id="context-menu" name="ContextMenu" source="ui/context-menu.tsx">
        <Specimen
          label="ContextMenu"
          note="Same item treatment as DropdownMenu — the two render the same actions from different triggers. Right-click the panel; touch and pen long-press it."
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex h-24 w-full items-center justify-center rounded-12 border border-dashed border-border text-ui text-muted-foreground">
                Right-click here
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel>3 selected</ContextMenuLabel>
              <ContextMenuItem>
                <Copy />
                Copy path
              </ContextMenuItem>
              <ContextMenuItem>
                <Archive />
                Archive
              </ContextMenuItem>
              <ContextMenuItem disabled>
                <Archive />
                Unavailable
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive">
                <Trash2 />
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </Specimen>
      </Component>

      <Component id="tooltip" name="Tooltip" source="ui/tooltip.tsx">
        <Specimen label="Tooltip">
          <TooltipProvider>
            <Row>
              {(["top", "right", "bottom", "left"] as const).map((side) => (
                <Tooltip key={side}>
                  <TooltipTrigger asChild>
                    <Button variant="outline">{side}</Button>
                  </TooltipTrigger>
                  <TooltipContent side={side}>Opens on {side}</TooltipContent>
                </Tooltip>
              ))}
            </Row>
          </TooltipProvider>
        </Specimen>
      </Component>
    </Section>
  );
}
