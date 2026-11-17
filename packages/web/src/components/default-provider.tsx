import { useState, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import { type DefaultModelProvider, useSetDefaultProvider } from "@/hooks/use-default-provider";

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

type ResendTarget = { chatId: string; agentName: string };

/**
 * A button that makes `provider` the default after the guardian confirms. The
 * AI Tools panel, a failure card and an outage notice share it, so the dialog
 * reads the same everywhere. `resend` also runs that chat's stopped request.
 */
export function MakeDefaultProviderButton({
  provider,
  resend,
  label,
  variant = "outline",
  size = "sm",
  className,
  onDone,
}: {
  provider: DefaultModelProvider;
  /** A chat to resend in, or a read of one when its agent is not known yet. */
  resend?: ResendTarget | (() => Promise<ResendTarget>);
  /** The button's text; "Set as default" when unset. */
  label?: ReactNode;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
  onDone?: () => void;
}) {
  const { t } = useTranslation("settings");
  const name = useProviderName()(provider);
  const [open, setOpen] = useState(false);
  const save = useSetDefaultProvider();
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
        onClick={() => setOpen(true)}
      >
        {label ?? t("aiTools.defaultProvider.setAsDefault")}
      </Button>
      <RomeConfirmDialog
        open={open}
        title={t("aiTools.defaultProvider.confirmTitle", { provider: name })}
        description={t("aiTools.defaultProvider.confirmBody", { provider: name })}
        confirmLabel={t("aiTools.defaultProvider.confirm")}
        cancelLabel={t("common.cancel")}
        confirmDisabled={save.isPending}
        onCancel={close}
        onConfirm={async () => {
          let target: ResendTarget | undefined;
          try {
            target = typeof resend === "function" ? await resend() : resend;
          } catch {
            target = undefined;
          }
          save.mutate(
            { provider, ...(target ? { resend: target } : {}) },
            {
              onSuccess: () => {
                setOpen(false);
                onDone?.();
              },
            },
          );
        }}
      >
        {provider === "rome_credits" || save.isError ? (
          <div className="space-y-2">
            {provider === "rome_credits" && (
              <p className="text-ui text-muted-foreground">
                {t("aiTools.defaultProvider.creditsBody")}
              </p>
            )}
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
