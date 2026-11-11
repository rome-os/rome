"use client";

import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface RomeConfirmDialogProps {
  cancelLabel?: string;
  // Disables the confirm button, e.g. while the confirmed action is in flight
  // and a second activation would resubmit it.
  confirmDisabled?: boolean;
  confirmLabel: string;
  description?: string;
  destructive?: boolean;
  // Overrides the default Rome logo above the title — e.g. a paired
  // Rome + integration lockup for a connect/disconnect dialog.
  icon?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}

export function RomeConfirmDialog({
  cancelLabel,
  confirmDisabled = false,
  confirmLabel,
  description,
  destructive = false,
  icon,
  onCancel,
  onConfirm,
  open,
  title,
}: RomeConfirmDialogProps) {
  const { t } = useTranslation("files");
  const resolvedCancelLabel = cancelLabel ?? t("dialog.cancel");
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      modal
      size="sm"
      ariaLabel={title}
      initialFocusRef={destructive ? cancelButtonRef : confirmButtonRef}
      className="p-6"
    >
      <div>
        <div className="mb-2">
          {icon ?? <RomeLogo className="block h-8 w-8 text-foreground" aria-hidden />}
        </div>
        <DialogTitle>{title}</DialogTitle>
        {description ? (
          <DialogDescription className="mt-2">{description}</DialogDescription>
        ) : (
          <DialogDescription className="sr-only">{title}</DialogDescription>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button ref={cancelButtonRef} variant="outline" onClick={onCancel}>
          {resolvedCancelLabel}
        </Button>
        <Button
          ref={confirmButtonRef}
          variant={destructive ? "destructive" : "default"}
          disabled={confirmDisabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
