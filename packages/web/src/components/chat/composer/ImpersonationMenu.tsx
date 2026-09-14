import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PersonResource } from "@rome/api-types/people";

export interface ImpersonationMenuProps {
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedPersonId: string;
  onSelectPersonId: (id: string) => void;
  options: PersonResource[];
  selectedPerson: PersonResource | null;
  selectedPersonLabel: string;
  guardianLabel: string;
}

export function ImpersonationMenu({
  disabled = false,
  open,
  onOpenChange,
  selectedPersonId,
  onSelectPersonId,
  options,
  selectedPerson,
  selectedPersonLabel,
  guardianLabel,
}: ImpersonationMenuProps) {
  const { t } = useTranslation("chat");

  return (
    <DropdownMenu
      open={open && !disabled}
      onOpenChange={(next) => {
        if (!disabled) onOpenChange(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          // Impersonation's default is the absence of a value, not a value —
          // there is no persona to name while the guardian speaks as itself. So
          // the trigger is a bare icon until someone is picked, and the name
          // appearing is the whole signal. A project and a model always have a
          // value, which is why those two always show one.
          size={selectedPerson ? "sm" : "icon-sm"}
          disabled={disabled}
          aria-label={t("impersonation.buttonLabel")}
          title={selectedPersonLabel}
          className="touch-target"
        >
          <Users aria-hidden />
          {selectedPerson && (
            <>
              <span className="max-w-[10rem] truncate">{selectedPerson.displayName}</span>
              <ChevronDown data-icon="inline-end" aria-hidden="true" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-64 p-0">
        <div className="border-b border-border-subtle px-3 py-2">
          <p className="text-aux text-subtle-foreground">{t("impersonation.menuTitle")}</p>
          <p className="mt-1 text-aux text-muted-foreground">
            {t("impersonation.currentlySpeakingAs", { name: selectedPersonLabel })}
          </p>
        </div>
        <div className="p-2">
          <DropdownMenuItem
            onSelect={() => {
              if (!disabled) onSelectPersonId("");
            }}
            className={cn(
              "justify-between rounded-8 px-3 py-2 text-ui",
              !selectedPersonId
                ? "bg-surface-muted text-foreground"
                : "text-foreground focus:bg-surface-muted",
            )}
          >
            <span>{guardianLabel}</span>
            {!selectedPersonId && (
              <span className="text-aux text-muted-foreground">{t("impersonation.default")}</span>
            )}
          </DropdownMenuItem>

          {options.map((person) => (
            <DropdownMenuItem
              key={person.id}
              onSelect={() => {
                if (!disabled) onSelectPersonId(person.id);
              }}
              className={cn(
                "mt-1 justify-between rounded-8 px-3 py-2 text-ui",
                selectedPersonId === person.id
                  ? "bg-info-bg text-info-fg focus:bg-info-bg"
                  : "text-foreground focus:bg-surface-muted",
              )}
            >
              <span>{person.displayName}</span>
              <span className="flex items-center gap-2">
                <span className="text-aux capitalize text-subtle-foreground">
                  {person.bondLevel}
                </span>
                {selectedPersonId === person.id && (
                  <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
              </span>
            </DropdownMenuItem>
          ))}

          {options.length === 0 && (
            <>
              <DropdownMenuSeparator className="mx-0" />
              <div className="px-3 py-2 text-ui text-subtle-foreground">
                {t("impersonation.noOtherUsers")}
              </div>
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
