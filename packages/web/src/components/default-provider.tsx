import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  type DefaultModelProvider,
  useDefaultProvider,
  useSetDefaultProvider,
} from "@/hooks/use-default-provider";

/** The name the guardian reads for a provider: Claude, ChatGPT, Rome credits. */
export function useProviderName(): (provider: DefaultModelProvider) => string {
  const { t } = useTranslation("settings");
  return (provider) =>
    provider === "anthropic"
      ? t("aiTools.providers.claudeCode.name")
      : provider === "openai"
        ? t("aiTools.providers.codex.name")
        : t("aiTools.romeCredits.name");
}

/**
 * Under "Move existing chats too": a checked move never takes a model its
 * owner picked. docs/domains/agents.md#pinned-chat
 */
export function OwnerPicksNote() {
  const { t } = useTranslation("settings");
  return (
    <p className="pl-6 text-aux text-muted-foreground">
      {t("aiTools.defaultProvider.ownerPicksKeep")}
    </p>
  );
}

/** A checkbox with its label, the whole row a target. */
export function LabeledCheckbox({
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex w-fit items-center gap-2 text-ui text-foreground">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      {children}
    </label>
  );
}

/**
 * "Set as default" in AI Tools, and the confirm dialog it opens. While chats
 * follow the default, the dialog asks whether they move too, checked by
 * default. docs/domains/agents.md#default-provider
 */
export function MakeDefaultProviderButton({
  provider,
  label,
  variant = "outline",
  size = "sm",
  className,
}: {
  provider: DefaultModelProvider;
  /** The button's text; "Set as default" when unset. */
  label?: ReactNode;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const name = useProviderName()(provider);
  const [open, setOpen] = useState(false);
  const [moveExisting, setMoveExisting] = useState(true);
  const { data: state } = useDefaultProvider();
  const save = useSetDefaultProvider();
  const asksToMove = (state?.followingChats ?? 0) > 0;
  const close = () => {
    if (save.isPending) return;
    setOpen(false);
    save.reset();
  };
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => {
          setMoveExisting(true);
          setOpen(true);
        }}
      >
        {label ?? t("aiTools.defaultProvider.setAsDefault")}
      </Button>
      <RomeConfirmDialog
        open={open}
        title={t("aiTools.defaultProvider.confirmTitle", { provider: name })}
        description={
          asksToMove && !moveExisting
            ? t("aiTools.defaultProvider.confirmBodyStay", { provider: name })
            : t("aiTools.defaultProvider.confirmBody", { provider: name })
        }
        confirmLabel={t("aiTools.defaultProvider.confirm")}
        cancelLabel={t("common.cancel")}
        confirmDisabled={save.isPending}
        onCancel={close}
        onConfirm={() =>
          save.mutate(
            { provider, moveExisting: asksToMove ? moveExisting : true },
            { onSuccess: () => setOpen(false) },
          )
        }
      >
        {asksToMove || save.isError ? (
          <div className="space-y-2">
            {asksToMove && (
              <LabeledCheckbox
                checked={moveExisting}
                disabled={save.isPending}
                onCheckedChange={setMoveExisting}
              >
                {t("aiTools.defaultProvider.moveExisting")}
              </LabeledCheckbox>
            )}
            {asksToMove && <OwnerPicksNote />}
            {save.isError && (
              <p role="alert" className="text-ui text-destructive">
                {save.error.message || t("aiTools.defaultProvider.saveFailed")}
              </p>
            )}
          </div>
        ) : null}
      </RomeConfirmDialog>
    </>
  );
}
