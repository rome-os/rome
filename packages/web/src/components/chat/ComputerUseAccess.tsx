import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Monitor } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type ChatComputerUseTarget, setChatComputerUseAccess } from "@/lib/chat-api";

interface AccessDecision {
  target: ChatComputerUseTarget;
  authorized: boolean;
}

export function ComputerUseAccess({
  sessionId,
  targets,
  selected,
  allowPreemption,
  onSelect,
  onTogglePreemption,
}: {
  sessionId: string;
  targets: ChatComputerUseTarget[];
  selected: ChatComputerUseTarget | undefined;
  allowPreemption: boolean;
  onSelect: (deviceId: string) => void;
  onTogglePreemption: () => void;
}) {
  const { t } = useTranslation("chat");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<AccessDecision | null>(null);
  const access = useMutation({
    mutationFn: ({ target, authorized }: AccessDecision) =>
      setChatComputerUseAccess(sessionId, target.deviceId, authorized),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["chat-computer-use"] });
      setDecision(null);
    },
    onError: () => toast.error(t("composer.computerUseSaveFailed")),
  });
  const confirmAccess = (target: ChatComputerUseTarget, authorized: boolean) => {
    setOpen(false);
    setDecision({ target, authorized });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-w-0 max-w-full touch-target"
          >
            <Monitor aria-hidden />
            <span className="truncate">
              {selected
                ? t("composer.computerUseActive", { name: selected.name })
                : t("composer.computerUseAccess")}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label={t("composer.computerUseAccess")}
          className="w-72 gap-2 rounded-12 p-2 shadow-10"
        >
          {targets.map((target) => (
            <div key={target.deviceId} className="flex min-w-0 items-center justify-between gap-2">
              <span title={target.name} className="truncate text-ui">
                {target.name}
              </span>
              <div className="flex shrink-0 gap-1">
                {target.authorized ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant={selected?.deviceId === target.deviceId ? "secondary" : "outline"}
                      aria-pressed={selected?.deviceId === target.deviceId}
                      aria-label={t("composer.computerUseSelectLabel", { name: target.name })}
                      onClick={() => onSelect(target.deviceId)}
                    >
                      {t("composer.computerUseSelect")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("composer.computerUseRevokeLabel", { name: target.name })}
                      onClick={() => confirmAccess(target, false)}
                    >
                      {t("composer.computerUseRevoke")}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={t("composer.computerUseAllowLabel", { name: target.name })}
                    onClick={() => confirmAccess(target, true)}
                  >
                    {t("composer.computerUseAllow")}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {selected && (
            <Button
              type="button"
              size="sm"
              variant={allowPreemption ? "secondary" : "outline"}
              aria-pressed={allowPreemption}
              className="h-auto min-h-8 whitespace-normal text-start"
              onClick={onTogglePreemption}
            >
              {t("composer.computerUsePreemption")}
            </Button>
          )}
        </PopoverContent>
      </Popover>
      {decision && (
        <RomeConfirmDialog
          open
          title={t(
            decision.authorized
              ? "composer.computerUseAllowLabel"
              : "composer.computerUseRevokeLabel",
            { name: decision.target.name },
          )}
          description={t(
            decision.authorized
              ? "composer.computerUseAllowDescription"
              : "composer.computerUseRevokeDescription",
            { name: decision.target.name },
          )}
          confirmLabel={t(
            decision.authorized ? "composer.computerUseAllow" : "composer.computerUseRevoke",
          )}
          confirmDisabled={access.isPending}
          destructive={!decision.authorized}
          icon={<Monitor aria-hidden className="size-8" />}
          onConfirm={() => access.mutate(decision)}
          onCancel={() => {
            if (!access.isPending) setDecision(null);
          }}
        />
      )}
    </>
  );
}
