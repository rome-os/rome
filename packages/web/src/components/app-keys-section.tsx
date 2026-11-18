import { appKeyNameError } from "@rome/api-types/app-keys";
import { VAULT_PIN_PATTERN, type VaultPinState, vaultNameError } from "@rome/api-types/vault";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, KeyRound, Plus, RefreshCw, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Field, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { RevealToggle } from "@/components/reveal-toggle";
import { PinInput, useErrorCount } from "@/components/vault-pin-input";
import { APP_KEYS_QUERY_KEY, deleteAppKey, fetchAppKeys, saveAppKey } from "@/lib/app-keys-api";
import { type EnvAppKey, parseAppKeysEnv } from "@/lib/parse-app-keys-env";
import {
  deleteVaultSecret,
  fetchVaultPin,
  fetchVaultSecrets,
  resetVault,
  saveVaultSecret,
  setVaultPin,
  VAULT_PIN_QUERY_KEY,
  VAULT_QUERY_KEY,
  VaultError,
  type VaultItem,
  vaultLockedText,
} from "@/lib/vault-api";

/** Blank form for "add"; prefilled name+label (value always retyped) for
 * "replace". The value is write-only end to end: the API never returns it, so
 * the form never has anything to show back. */
type FormState = { mode: "add" } | { mode: "replace"; name: string; label: string };

/** What one list row needs. The write-only value never appears here. */
interface KeyRowItem {
  name: string;
  label: string;
  overridden: boolean;
}

/**
 * What differs between the stores this row can manage (App keys, the Vault):
 * where the list comes from, how a save and a remove are sent, and which
 * strings to show. `i18nPrefix` names a group in settings.json. A string the
 * group lacks falls back to the same string under `appKeys`, so a group lists
 * only the texts that differ.
 */
interface KeysRowSpec<T extends KeyRowItem = KeyRowItem> {
  queryKey: readonly unknown[];
  fetch: () => Promise<T[]>;
  save: (input: {
    name: string;
    label: string;
    value: string;
    pin?: string;
  }) => Promise<{ overridden: boolean }>;
  /** Set for a store that asks for a PIN on every save. */
  pin?: KeysPinSpec;
  remove: (name: string) => Promise<void>;
  i18nPrefix: string;
  nameError: (name: string) => string | null;
  /** What the form's label field starts with when replacing a row. Defaults to the row's label. */
  formLabel?: (item: T) => string;
  /** The label saved when the field is left blank. Defaults to the name. */
  blankLabel?: (name: string) => string;
  /** Extra text or badges after a row's name. */
  meta?: (item: T) => ReactNode;
}

/** How a store with a PIN reads its state, sets the first PIN, and resets. */
interface KeysPinSpec {
  /** Sits under the spec's `queryKey`, so refreshing the list refreshes the PIN state. */
  queryKey: readonly unknown[];
  fetch: () => Promise<VaultPinState>;
  set: (pin: string) => Promise<void>;
  /** Deletes every key and sets a new PIN. */
  reset: (pin: string) => Promise<void>;
  /** The failure is about the PIN, so the next save in a batch would repeat it. */
  isPinError: (error: unknown) => boolean;
}

const NO_PIN_QUERY_KEY = ["keys-without-pin"] as const;

const APP_KEYS_SPEC: KeysRowSpec = {
  queryKey: APP_KEYS_QUERY_KEY,
  fetch: fetchAppKeys,
  save: saveAppKey,
  remove: deleteAppKey,
  i18nPrefix: "appKeys",
  nameError: appKeyNameError,
};

function formatTime(iso: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString(undefined, options);
}

function VaultItemMeta({ item }: { item: VaultItem }) {
  const { t } = useTranslation("settings");
  return (
    <>
      <span>
        {item.lastUsedAt
          ? t("vault.lastUsed", {
              time: formatTime(item.lastUsedAt, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }),
            })
          : t("vault.neverUsed")}
      </span>
      {item.grantedUntil && (
        <Badge variant="success" className="whitespace-nowrap">
          {t("vault.grantedUntil", {
            time: formatTime(item.grantedUntil, { hour: "2-digit", minute: "2-digit" }),
          })}
        </Badge>
      )}
    </>
  );
}

const VAULT_SPEC: KeysRowSpec<VaultItem> = {
  queryKey: VAULT_QUERY_KEY,
  fetch: fetchVaultSecrets,
  save: saveVaultSecret,
  remove: deleteVaultSecret,
  pin: {
    queryKey: VAULT_PIN_QUERY_KEY,
    fetch: fetchVaultPin,
    set: setVaultPin,
    reset: resetVault,
    isPinError: (error) => error instanceof VaultError && error.isPinError,
  },
  i18nPrefix: "vault",
  nameError: vaultNameError,
  // The row title falls back to the name, but the description does not.
  formLabel: (item) => item.description,
  blankLabel: () => "",
  meta: (item) => <VaultItemMeta item={item} />,
};

/** Translates against the spec's group first, then `appKeys`. */
function useKeysText(prefix: string) {
  const { t } = useTranslation("settings");
  return (key: string, options?: Record<string, unknown>): string =>
    t([`${prefix}.${key}`, `appKeys.${key}`], options) as string;
}

export function AppKeysRow() {
  return <KeysRow spec={APP_KEYS_SPEC} />;
}

export function VaultRow() {
  return <KeysRow spec={VAULT_SPEC} />;
}

/**
 * A key store as one row in a `FormRows` group, with the stored count, and a
 * side sheet that manages them. The sheet shows either the key list or the add
 * or replace form, never both, so the form has the sheet's full width and the
 * header's back arrow returns to the list.
 */
function KeysRow<T extends KeyRowItem>({ spec }: { spec: KeysRowSpec<T> }) {
  const tk = useKeysText(spec.i18nPrefix);
  const [open, setOpen] = useState(false);
  // Closing unmounts the form, so it waits for a save: a .env batch keeps its
  // failed entries in the form for a retry.
  const [saving, setSaving] = useState(false);
  const close = () => {
    if (!saving) setOpen(false);
  };
  const keysQuery = useQuery({ queryKey: spec.queryKey, queryFn: spec.fetch });
  const count = keysQuery.data?.length;

  const summary =
    count === undefined
      ? tk("summary")
      : `${count === 0 ? tk("noKeysYet") : tk("keyCount", { count })} · ${tk("summary")}`;

  return (
    <>
      <FormRow>
        <FormRowHeading>
          <FormRowLabel>{tk("title")}</FormRowLabel>
          <FormRowDescription>{summary}</FormRowDescription>
        </FormRowHeading>
        <FormRowControl>
          <Button
            variant="outline"
            size="sm"
            aria-label={tk("openLabel")}
            onClick={() => setOpen(true)}
          >
            {tk("manage")}
          </Button>
        </FormRowControl>
      </FormRow>
      <Sheet open={open} onClose={close} ariaLabel={tk("title")} widthClassName="w-full max-w-lg">
        {/* Mounted only while open, so each opening starts on the list. */}
        <KeysManager spec={spec} onClose={close} onSavingChange={setSaving} />
      </Sheet>
    </>
  );
}

function KeysManager<T extends KeyRowItem>({
  spec,
  onClose,
  onSavingChange,
}: {
  spec: KeysRowSpec<T>;
  onClose: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const { t: tRoot } = useTranslation("settings");
  const tk = useKeysText(spec.i18nPrefix);
  const uid = useId();
  const queryClient = useQueryClient();
  const keysQuery = useQuery({ queryKey: spec.queryKey, queryFn: spec.fetch });
  const formLabelOf = spec.formLabel ?? ((item: T) => item.label);
  const blankLabelOf = spec.blankLabel ?? ((name: string) => name);

  const [form, setForm] = useState<FormState | null>(null);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [inputMode, setInputMode] = useState("single");
  const [envContent, setEnvContent] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<T | null>(null);

  // A store with a PIN asks for it in a step before the form. The PIN is held
  // in a ref until the save that uses it settles. Nothing stores it: it is not
  // in the query cache, not in a mutation variable, and not in storage.
  const pinSpec = spec.pin;
  const pinQuery = useQuery<VaultPinState | null>({
    queryKey: pinSpec?.queryKey ?? NO_PIN_QUERY_KEY,
    queryFn: pinSpec?.fetch ?? (() => Promise.resolve(null)),
    enabled: pinSpec !== undefined,
  });
  const pinState = pinQuery.data ?? null;
  const pinSet = pinState?.set ?? false;
  const lockedUntil = pinState?.lockedUntil ?? null;
  const locked = lockedUntil !== null && Date.parse(lockedUntil) > Date.now();
  const [askPin, setAskPin] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetPin, setResetPin] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const pinShake = useErrorCount(pinError);
  const heldPin = useRef("");
  // The PIN a set or a reset sends, read by the mutation instead of passed to it.
  const newPin = useRef("");

  const clearPin = () => {
    heldPin.current = "";
    setPin("");
    setConfirmPin("");
  };
  const openForm = (next: FormState) => {
    setForm(next);
    setLabel(next.mode === "replace" ? next.label : "");
    setName(next.mode === "replace" ? next.name : "");
    setValue("");
    setShowValue(false);
    setInputMode("single");
    setEnvContent("");
    setFormError(null);
    clearPin();
    setPinError(null);
    setAskPin(pinSpec !== undefined);
  };
  const closeForm = () => {
    setForm(null);
    setValue("");
    setShowValue(false);
    setEnvContent("");
    setFormError(null);
    clearPin();
    setPinError(null);
    setAskPin(false);
  };
  // Back to the PIN step with the form's typed values kept, so a refused PIN
  // costs the guardian only the PIN.
  const askPinAgain = (message: string) => {
    clearPin();
    setPinError(message);
    setAskPin(true);
    void refreshPin();
  };
  const refreshPin = () =>
    pinSpec ? queryClient.invalidateQueries({ queryKey: pinSpec.queryKey }) : Promise.resolve();
  const closeReset = () => {
    setResetting(false);
    setResetPin("");
    setResetConfirm("");
    setResetError(null);
  };

  const saveMutation = useMutation({
    mutationFn: (input: Omit<Parameters<typeof spec.save>[0], "pin">) =>
      spec.save({ ...input, pin: pinSpec ? heldPin.current : undefined }),
    onSuccess: async (result, input) => {
      closeForm();
      await queryClient.invalidateQueries({ queryKey: spec.queryKey });
      if (result.overridden) {
        toast.warning(tk("savedOverridden"));
      } else {
        toast.success(tk("saved", { name: input.name }));
      }
    },
    onError: (error: Error) =>
      pinSpec?.isPinError(error) ? askPinAgain(error.message) : setFormError(error.message),
  });

  const batchMutation = useMutation({
    mutationFn: async (entries: EnvAppKey[]) => {
      const existingKeys = await queryClient.fetchQuery({
        queryKey: spec.queryKey,
        queryFn: spec.fetch,
        staleTime: 0,
        retry: false,
      });
      const failed: EnvAppKey[] = [];
      let overridden = false;
      let stopped: Error | null = null;
      for (const [index, entry] of entries.entries()) {
        try {
          const existing = existingKeys.find((key) => key.name === entry.name);
          const result = await spec.save({
            name: entry.name,
            value: entry.value,
            label: existing ? formLabelOf(existing) : blankLabelOf(entry.name),
            pin: pinSpec ? heldPin.current : undefined,
          });
          overridden ||= result.overridden;
        } catch (error) {
          failed.push(entry);
          // Every later save would repeat a refused PIN and spend an attempt.
          if (pinSpec?.isPinError(error)) {
            stopped = error as Error;
            failed.push(...entries.slice(index + 1));
            break;
          }
        }
      }
      return { failed, saved: entries.length - failed.length, overridden, stopped };
    },
    onSuccess: async ({ failed, saved, overridden, stopped }) => {
      if (failed.length > 0) {
        setEnvContent(failed.map((entry) => entry.source).join("\n"));
        if (stopped) askPinAgain(stopped.message);
        else setFormError(tk("form.batchFailed", { saved, count: failed.length }));
      } else {
        closeForm();
      }
      if (saved > 0) toast.success(tk("batchSaved", { count: saved }));
      if (overridden) toast.warning(tk("batchOverridden"));
      await queryClient.invalidateQueries({ queryKey: spec.queryKey });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const isSaving = saveMutation.isPending || batchMutation.isPending;
  useEffect(() => {
    onSavingChange(isSaving);
    return () => onSavingChange(false);
  }, [isSaving, onSavingChange]);

  const removeMutation = useMutation({
    mutationFn: spec.remove,
    onSuccess: async (_result, removedName) => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: spec.queryKey });
      toast.success(tk("removed", { name: removedName }));
    },
    onError: (error: Error) => {
      setRemoving(null);
      toast.error(error.message);
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      await pinSpec?.reset(newPin.current);
    },
    // The new PIN is the one the flow continues with.
    onSuccess: async () => {
      heldPin.current = newPin.current;
      newPin.current = "";
      closeReset();
      setPinError(null);
      setAskPin(false);
      await queryClient.invalidateQueries({ queryKey: spec.queryKey });
    },
    onError: (error: Error) => {
      newPin.current = "";
      setResetError(error.message);
    },
  });

  const setPinMutation = useMutation({
    mutationFn: async () => {
      await pinSpec?.set(newPin.current);
    },
    onSuccess: async () => {
      heldPin.current = newPin.current;
      newPin.current = "";
      setPin("");
      setConfirmPin("");
      setPinError(null);
      setAskPin(false);
      await refreshPin();
    },
    onError: async (error: Error) => {
      newPin.current = "";
      setPinError(error.message);
      // A PIN that is already set moves the step to entering it.
      await refreshPin();
    },
  });

  // Typing again answers the error, so the slots stop reading as wrong.
  const editPin = (set: (pin: string) => void) => (next: string) => {
    set(next);
    setPinError(null);
  };

  const continuePin = () => {
    if (!VAULT_PIN_PATTERN.test(pin) || locked || !pinState) return;
    if (pinSet) {
      heldPin.current = pin;
      setPin("");
      setPinError(null);
      setAskPin(false);
    } else if (pin !== confirmPin) {
      setPinError(tk("form.pinMismatch"));
    } else {
      newPin.current = pin;
      setPinMutation.mutate();
    }
  };

  const submit = () => {
    if (isSaving) return;
    setFormError(null);
    if (form?.mode === "add" && inputMode === "env") {
      const parsed = parseAppKeysEnv(envContent, spec.nameError);
      if (parsed.error) {
        const { line, reason, detail } = parsed.error;
        setFormError(
          tk("form.envError", {
            line,
            reason: detail ?? tk(`form.envErrors.${reason}`),
          }),
        );
        return;
      }
      if (parsed.entries.length === 0) {
        setFormError(tk("form.envEmpty"));
        return;
      }
      batchMutation.mutate(parsed.entries);
      return;
    }
    const trimmedName = name.trim();
    const nameError = spec.nameError(trimmedName);
    if (nameError) {
      setFormError(nameError);
      return;
    }
    if (!value) {
      setFormError(tk("form.valueRequired"));
      return;
    }
    saveMutation.mutate({
      name: trimmedName,
      label: label.trim() || blankLabelOf(trimmedName),
      value,
    });
  };

  const keys = keysQuery.data ?? [];
  const signerOutdated =
    keysQuery.error instanceof VaultError && keysQuery.error.code === "signer_outdated";
  const shownError = pinError ?? (locked ? vaultLockedText(lockedUntil ?? undefined) : null);
  const resetDialog = pinSpec && (
    <RomeConfirmDialog
      open={resetting}
      title={tk("reset.title", { count: keys.length })}
      destructive
      confirmLabel={tk("reset.confirm")}
      confirmDisabled={
        resetMutation.isPending || !VAULT_PIN_PATTERN.test(resetPin) || resetPin !== resetConfirm
      }
      onConfirm={() => {
        newPin.current = resetPin;
        resetMutation.mutate();
      }}
      onCancel={closeReset}
    >
      <div className="space-y-3">
        <Field>
          <FieldLabel htmlFor={`${uid}-reset-pin`}>{tk("form.newPin")}</FieldLabel>
          <PinInput id={`${uid}-reset-pin`} value={resetPin} onChange={setResetPin} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-reset-confirm`}>{tk("form.confirmPin")}</FieldLabel>
          <PinInput id={`${uid}-reset-confirm`} value={resetConfirm} onChange={setResetConfirm} />
        </Field>
        {resetError && (
          <p role="alert" className="text-ui text-destructive">
            {resetError}
          </p>
        )}
      </div>
    </RomeConfirmDialog>
  );

  if (form !== null && askPin) {
    return (
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          continuePin();
        }}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
          <IconButton
            size="sm"
            label={tk("form.back")}
            icon={<ArrowLeft />}
            onClick={closeForm}
            disabled={setPinMutation.isPending}
          />
          <SheetTitle className="flex-1 truncate text-title text-foreground">
            {pinSet ? tk("pinStep.enterTitle") : tk("pinStep.setTitle")}
          </SheetTitle>
        </div>
        <fieldset
          disabled={setPinMutation.isPending}
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4"
        >
          {pinState && (
            <>
              {/* Entering needs no label under the "Enter PIN" title; setting names both rows. */}
              <Field>
                {!pinSet && <FieldLabel htmlFor={`${uid}-pin`}>{tk("form.newPin")}</FieldLabel>}
                <PinInput
                  id={`${uid}-pin`}
                  aria-label={pinSet ? tk("form.pin") : undefined}
                  value={pin}
                  onChange={editPin(setPin)}
                  disabled={locked}
                  invalid={Boolean(pinError)}
                  shakeKey={pinShake}
                />
              </Field>
              {!pinSet && (
                <Field>
                  <FieldLabel htmlFor={`${uid}-pin-confirm`}>{tk("form.confirmPin")}</FieldLabel>
                  <PinInput
                    id={`${uid}-pin-confirm`}
                    value={confirmPin}
                    onChange={editPin(setConfirmPin)}
                    invalid={Boolean(pinError)}
                    shakeKey={pinShake}
                  />
                </Field>
              )}
            </>
          )}
          {shownError && (
            <p role="alert" className="text-ui text-destructive">
              {shownError}
            </p>
          )}
          {pinSet && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0"
              onClick={() => setResetting(true)}
            >
              {tk("forgotPin")}
            </Button>
          )}
        </fieldset>
        <div className="flex shrink-0 justify-end border-t border-border p-4">
          <Button
            type="submit"
            size="sm"
            disabled={
              setPinMutation.isPending ||
              locked ||
              !pinState ||
              !VAULT_PIN_PATTERN.test(pin) ||
              (!pinSet && !VAULT_PIN_PATTERN.test(confirmPin))
            }
          >
            {tk("pinStep.continue")}
          </Button>
        </div>
        {/* It renders in a portal, so its buttons cannot submit this form. */}
        {resetDialog}
      </form>
    );
  }

  if (form !== null) {
    return (
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
          <IconButton
            size="sm"
            label={tk("form.back")}
            icon={<ArrowLeft />}
            onClick={closeForm}
            disabled={isSaving}
          />
          <SheetTitle className="flex-1 truncate text-title text-foreground">
            {form.mode === "add"
              ? tk("form.titleAdd")
              : tk("form.titleReplace", { name: form.name })}
          </SheetTitle>
        </div>
        <fieldset
          disabled={isSaving}
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4"
        >
          <Tabs
            value={inputMode}
            onValueChange={(mode) => {
              setInputMode(mode);
              setFormError(null);
            }}
          >
            {form.mode === "add" && (
              <TabsList aria-label={tk("form.inputMethod")}>
                <TabsTrigger value="single" disabled={isSaving}>
                  {tk("form.singleKey")}
                </TabsTrigger>
                <TabsTrigger value="env" disabled={isSaving}>
                  {tk("form.pasteEnv")}
                </TabsTrigger>
              </TabsList>
            )}
            <TabsContent value="single" className="space-y-4">
              <Field>
                <FieldLabel htmlFor={`${uid}-app-key-label`}>{tk("form.labelField")}</FieldLabel>
                <Input
                  id={`${uid}-app-key-label`}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={tk("form.labelPlaceholder")}
                  className="w-full"
                  autoFocus={form.mode === "add"}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-app-key-name`}>{tk("form.nameField")}</FieldLabel>
                <Input
                  id={`${uid}-app-key-name`}
                  value={name}
                  onChange={(e) => setName(e.target.value.toUpperCase())}
                  placeholder={tk("form.namePlaceholder")}
                  disabled={form.mode === "replace"}
                  className="w-full font-mono"
                />
                <p className="mt-1 text-aux text-muted-foreground">{tk("form.nameHint")}</p>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-app-key-value`}>{tk("form.valueField")}</FieldLabel>
                <div className="relative">
                  <Input
                    id={`${uid}-app-key-value`}
                    type={showValue ? "text" : "password"}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    autoComplete="off"
                    className="w-full pr-12"
                    autoFocus={form.mode === "replace"}
                  />
                  <RevealToggle
                    shown={showValue}
                    onToggle={() => setShowValue((shown) => !shown)}
                    showLabel={tk("form.showValue")}
                    hideLabel={tk("form.hideValue")}
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                  />
                </div>
                <p className="mt-1 text-aux text-muted-foreground">{tk("form.valueHint")}</p>
              </Field>
            </TabsContent>
            {form.mode === "add" && (
              <TabsContent value="env">
                <Field>
                  <FieldLabel htmlFor={`${uid}-app-keys-env`}>{tk("form.envContent")}</FieldLabel>
                  <Textarea
                    id={`${uid}-app-keys-env`}
                    value={envContent}
                    onChange={(event) => setEnvContent(event.target.value)}
                    placeholder={"ENV_VAR_1=value1\nENV_VAR_2=value2"}
                    rows={10}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full font-mono"
                    aria-describedby={`${uid}-app-keys-env-hint`}
                  />
                  <p
                    id={`${uid}-app-keys-env-hint`}
                    className="mt-1 text-aux text-muted-foreground"
                  >
                    {tk("form.envHint")}
                  </p>
                </Field>
              </TabsContent>
            )}
          </Tabs>
          {formError && (
            <p role="alert" className="text-ui text-destructive">
              {formError}
            </p>
          )}
        </fieldset>
        {/* The footer stays in view under a long .env paste. */}
        <div className="shrink-0 space-y-3 border-t border-border p-4">
          <p className="text-ui text-muted-foreground">{tk("form.consent")}</p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={closeForm}
              disabled={isSaving}
            >
              {tk("form.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={isSaving}>
              {isSaving ? tk("form.saving") : tk("form.save")}
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
        <SheetTitle className="flex-1 truncate text-title text-foreground">
          {tk("title")}
        </SheetTitle>
        {!signerOutdated && (
          <Button type="button" size="sm" onClick={() => openForm({ mode: "add" })}>
            <Plus data-icon="inline-start" aria-hidden />
            {tk("add")}
          </Button>
        )}
        <IconButton size="sm" label={tk("form.close")} icon={<X />} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {keysQuery.isLoading ? (
          <div className="flex flex-col gap-2" role="status" aria-label={tk("loading")}>
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : signerOutdated ? (
          <p className="text-ui text-muted-foreground">{keysQuery.error?.message}</p>
        ) : keysQuery.isError ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertTitle>{tk("errorTitle")}</AlertTitle>
            <AlertDescription>
              <p>{keysQuery.error.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void keysQuery.refetch()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden />
                {tRoot("page.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : keys.length === 0 ? (
          <EmptyState className="rounded-8 border border-dashed border-border bg-surface/50">
            <EmptyStateIcon>
              <KeyRound aria-hidden />
            </EmptyStateIcon>
            <EmptyStateTitle>{tk("emptyTitle")}</EmptyStateTitle>
            <p className="text-ui text-muted-foreground">{tk("emptyBody")}</p>
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {keys.map((key) => (
              <li key={key.name} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ui text-foreground" title={key.label}>
                    {key.label}
                  </p>
                  <p className="flex min-w-0 items-center gap-2 text-aux text-muted-foreground">
                    {key.label !== key.name && (
                      <span className="truncate font-mono" title={key.name}>
                        {key.name}
                      </span>
                    )}
                    {key.overridden ? (
                      <Badge variant="warning" title={tk("overriddenHint")}>
                        {tk("overridden")}
                      </Badge>
                    ) : (
                      <>
                        <span className="font-mono" aria-hidden>
                          ••••••••
                        </span>
                        <span className="sr-only">{tk("valueHidden")}</span>
                      </>
                    )}
                  </p>
                  {spec.meta && (
                    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-aux text-muted-foreground">
                      {spec.meta(key)}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      openForm({ mode: "replace", name: key.name, label: formLabelOf(key) })
                    }
                  >
                    {tk("replace")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRemoving(key)}
                  >
                    {tk("remove")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <RomeConfirmDialog
        open={removing !== null}
        title={tk("removeTitle", { name: removing?.name ?? "" })}
        description={tk("removeBody")}
        destructive
        confirmLabel={tk("remove")}
        confirmDisabled={removeMutation.isPending}
        onConfirm={() => {
          if (removing) removeMutation.mutate(removing.name);
        }}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
