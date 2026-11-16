import { appKeyNameError } from "@rome/api-types/app-keys";
import { vaultNameError } from "@rome/api-types/vault";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, KeyRound, Plus, RefreshCw, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
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
import { APP_KEYS_QUERY_KEY, deleteAppKey, fetchAppKeys, saveAppKey } from "@/lib/app-keys-api";
import { type EnvAppKey, parseAppKeysEnv } from "@/lib/parse-app-keys-env";
import {
  deleteVaultSecret,
  fetchVaultSecrets,
  saveVaultSecret,
  VAULT_QUERY_KEY,
  type VaultItem,
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
  save: (input: { name: string; label: string; value: string }) => Promise<{ overridden: boolean }>;
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
  const [inputMode, setInputMode] = useState("single");
  const [envContent, setEnvContent] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<T | null>(null);

  const openForm = (next: FormState) => {
    setForm(next);
    setLabel(next.mode === "replace" ? next.label : "");
    setName(next.mode === "replace" ? next.name : "");
    setValue("");
    setInputMode("single");
    setEnvContent("");
    setFormError(null);
  };
  const closeForm = () => {
    setForm(null);
    setValue("");
    setEnvContent("");
    setFormError(null);
  };

  const saveMutation = useMutation({
    mutationFn: spec.save,
    onSuccess: async (result, input) => {
      closeForm();
      await queryClient.invalidateQueries({ queryKey: spec.queryKey });
      if (result.overridden) {
        toast.warning(tk("savedOverridden"));
      } else {
        toast.success(tk("saved", { name: input.name }));
      }
    },
    onError: (error: Error) => setFormError(error.message),
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
      for (const entry of entries) {
        try {
          const existing = existingKeys.find((key) => key.name === entry.name);
          const result = await spec.save({
            name: entry.name,
            value: entry.value,
            label: existing ? formLabelOf(existing) : blankLabelOf(entry.name),
          });
          overridden ||= result.overridden;
        } catch {
          failed.push(entry);
        }
      }
      return { failed, saved: entries.length - failed.length, overridden };
    },
    onSuccess: async ({ failed, saved, overridden }) => {
      if (failed.length > 0) {
        setEnvContent(failed.map((entry) => entry.source).join("\n"));
        setFormError(tk("form.batchFailed", { saved, count: failed.length }));
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
                <Input
                  id={`${uid}-app-key-value`}
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="off"
                  className="w-full"
                  autoFocus={form.mode === "replace"}
                />
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
        <Button type="button" size="sm" onClick={() => openForm({ mode: "add" })}>
          <Plus data-icon="inline-start" aria-hidden />
          {tk("add")}
        </Button>
        <IconButton size="sm" label={tk("form.close")} icon={<X />} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {keysQuery.isLoading ? (
          <div className="flex flex-col gap-2" role="status" aria-label={tk("loading")}>
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
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
