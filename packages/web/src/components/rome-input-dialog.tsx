"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { useForm } from "@tanstack/react-form";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface RomeInputDialogProps {
  cancelLabel?: string;
  confirmLabel: string;
  description?: string;
  error?: string | null;
  initialValue: string;
  icon?: ReactNode;
  inputLabel: string;
  inputPlaceholder?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
  open: boolean;
  title: string;
  /** Optional content rendered below the input (e.g. a sync-source picker). */
  children?: ReactNode;
  /** The confirm is running: its button is disabled and marked busy. */
  busy?: boolean;
}

export function RomeInputDialog({
  cancelLabel,
  confirmLabel,
  description,
  error,
  initialValue,
  icon,
  inputLabel,
  inputPlaceholder,
  onCancel,
  onConfirm,
  open,
  title,
  children,
  busy = false,
}: RomeInputDialogProps) {
  const { t } = useTranslation("files");
  const resolvedCancelLabel = cancelLabel ?? t("dialog.cancel");
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const form = useForm({
    defaultValues: { value: initialValue },
    onSubmit: ({ value }) => onConfirm(value.value),
  });

  // The dialog is reused across open/close cycles; re-seed the field whenever it
  // reopens (or the caller's initial value changes) so stale input never lingers.
  useEffect(() => {
    if (open) {
      form.reset({ value: initialValue });
    }
  }, [open, initialValue, form]);

  // Dialog.initialFocusRef calls focus() but not select(); for a rename-style
  // flow we want the whole value selected so the user can type to replace.
  useEffect(() => {
    if (open) {
      // Defer until Radix has handed focus over.
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="sm"
      ariaLabel={title}
      initialFocusRef={inputRef}
      className="p-6"
      aria-describedby={error ? errorId : undefined}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div>
          <div className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-8 bg-primary text-badge text-primary-foreground">
            {icon ?? "R"}
          </div>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription className="mt-2">{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </div>

        <div className="mt-5">
          <form.Field name="value">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>{inputLabel}</FieldLabel>
                <Input
                  ref={inputRef}
                  id={field.name}
                  name={field.name}
                  placeholder={inputPlaceholder}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  aria-describedby={error ? errorId : undefined}
                />
              </Field>
            )}
          </form.Field>
          {error && (
            <p id={errorId} role="alert" className="mt-1 text-ui text-destructive-fg">
              {error}
            </p>
          )}
        </div>

        {children ? <div className="mt-4">{children}</div> : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            {resolvedCancelLabel}
          </Button>
          <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
