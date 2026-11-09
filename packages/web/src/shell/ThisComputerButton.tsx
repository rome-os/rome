import type { NodeThisDeviceState } from "@rome-os/node-ui";
import { Laptop, ScrollText } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useThisDevice } from "@/hooks/use-this-device";

/** The dot's color per state. A disabled computer has no dot, and a connecting one pulses. */
const DOT_CLASS: Record<Exclude<NodeThisDeviceState, "disabled">, string> = {
  connected: "bg-success",
  connecting: "bg-warning motion-safe:animate-pulse",
  offline: "bg-subtle-foreground",
};

/**
 * The sidebar's "this computer" control: whether Rome can use the Mac the dashboard runs in,
 * and the switch for it. Renders nothing outside the Mac app or while it has not answered.
 */
export function ThisComputerButton({ tooltipSide = "top" }: { tooltipSide?: "top" | "right" }) {
  const { t } = useTranslation("common");
  const device = useThisDevice();
  const [open, setOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  // Closing the popover hands focus back to the button, and a focus-opened tooltip would flash
  // right after. The flag holds until the pointer crosses the button's edge or focus leaves it.
  const refocused = useRef(false);
  const switchId = useId();

  if (!device) return null;
  const { state } = device;
  const label = t(`thisComputer.tooltip.${state}`);

  return (
    <TooltipProvider delayDuration={150}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip
          open={tipOpen && !open}
          onOpenChange={(next) => setTipOpen(next && !refocused.current)}
        >
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <IconButton
                size="sm"
                label={label}
                title={undefined}
                onPointerEnter={() => {
                  refocused.current = false;
                }}
                onPointerLeave={() => {
                  refocused.current = false;
                }}
                onBlur={() => {
                  refocused.current = false;
                }}
                className="group text-subtle-foreground hover:text-foreground data-[state=open]:bg-surface-hover data-[state=open]:text-foreground"
                icon={
                  <span className="relative inline-flex">
                    <Laptop
                      aria-hidden
                      className={state === "disabled" ? "opacity-45" : undefined}
                    />
                    {/* Centered on the base's bottom-right corner in the Laptop path's 24-unit viewBox:
                        x = 21.386 (the corner arc's rightmost point), y = 20. Percentages of the
                        icon box keep it there at any glyph size. */}
                    {state === "disabled" ? null : (
                      <span
                        aria-hidden
                        data-slot="computer-dot"
                        className={`absolute top-[calc(83.33%-3px)] left-[calc(89.11%-3px)] size-1.5 rounded-full ring-2 ring-background group-hover:ring-surface-hover group-data-[state=open]:ring-surface-hover ${DOT_CLASS[state]}`}
                      />
                    )}
                  </span>
                }
              />
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} collisionPadding={8}>
            {label}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          className="w-64 gap-0 p-1"
          onCloseAutoFocus={() => {
            refocused.current = true;
          }}
        >
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <label htmlFor={switchId} className="text-ui text-foreground">
                {t("thisComputer.label")}
              </label>
              <span className="text-aux text-muted-foreground">
                {t(`thisComputer.state.${state}`)}
              </span>
            </div>
            <Switch
              id={switchId}
              size="sm"
              checked={state !== "disabled"}
              disabled={device.busy}
              onCheckedChange={device.onEnabledChange}
            />
          </div>
          {device.openAuditLog ? (
            <>
              <Separator className="my-1" />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  device.openAuditLog?.();
                }}
                className="flex min-h-[var(--control-min-h)] w-full items-center gap-2 rounded-8 px-2 py-1 text-left text-ui text-foreground outline-1 outline-offset-0 outline-transparent transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-ring/50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
              >
                <ScrollText aria-hidden />
                {t("thisComputer.auditLog")}
              </button>
            </>
          ) : null}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
