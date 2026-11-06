import { appKeyNameError } from "@rome/api-types/app-keys";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
  FormRows,
} from "@rome-os/ui/layout-form";
import { Section, SectionHeader, SectionTitle } from "@rome-os/ui/page";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, KeyRound, Plus, RefreshCw, X } from "lucide-react";
import { useId, useState } from "react";
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
import {
  APP_KEYS_QUERY_KEY,
  type AppKeyDto,
  deleteAppKey,
  fetchAppKeys,
  saveAppKey,
} from "@/lib/app-keys-api";
import { type EnvAppKey, parseAppKeysEnv } from "@/lib/parse-app-keys-env";

/** Blank form for "add"; prefilled name+label (value always retyped) for
 * "replace". The value is write-only end to end: the API never returns it, so
 * the form never has anything to show back. */
type FormState = { mode: "add" } | { mode: "replace"; name: string; label: string };

/**
 * App keys on the Advanced tab: one row with the stored-key count, and a side
 * sheet that manages them. The sheet shows either the key list or the add or
 * replace form, never both, so the form has the sheet's full width and the
 * header's back arrow returns to the list.
 */
export function AppKeysSection() {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const keysQuery = useQuery({ queryKey: APP_KEYS_QUERY_KEY, queryFn: fetchAppKeys });
  const count = keysQuery.data?.length;

  return (
    <Section>
      <SectionHeader>
        <SectionTitle>{t("appKeys.title")}</SectionTitle>
      </SectionHeader>
      <FormRows>
        <FormRow>
          <FormRowHeading>
            <FormRowLabel>
              {count === undefined
                ? t("appKeys.title")
                : count === 0
                  ? t("appKeys.noKeysYet")
                  : t("appKeys.keyCount", { count })}
            </FormRowLabel>
            <FormRowDescription>{t("appKeys.summary")}</FormRowDescription>
          </FormRowHeading>
          <FormRowControl>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("appKeys.openLabel")}
              onClick={() => setOpen(true)}
            >
              {t("appKeys.manage")}
            </Button>
          </FormRowControl>
        </FormRow>
      </FormRows>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={t("appKeys.title")}
        widthClassName="w-full max-w-lg"
      >
        {/* Mounted only while open, so each opening starts on the list. */}
        <AppKeysManager onClose={() => setOpen(false)} />
      </Sheet>
    </Section>
  );
}

function AppKeysManager({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settings");
  const uid = useId();
  const queryClient = useQueryClient();
  const keysQuery = useQuery({ queryKey: APP_KEYS_QUERY_KEY, queryFn: fetchAppKeys });

  const [form, setForm] = useState<FormState | null>(null);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [inputMode, setInputMode] = useState("single");
  const [envContent, setEnvContent] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AppKeyDto | null>(null);

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
    mutationFn: saveAppKey,
    onSuccess: async (result, input) => {
      closeForm();
      await queryClient.invalidateQueries({ queryKey: APP_KEYS_QUERY_KEY });
      if (result.overridden) {
        toast.warning(t("appKeys.savedOverridden"));
      } else {
        toast.success(t("appKeys.saved", { name: input.name }));
      }
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const batchMutation = useMutation({
    mutationFn: async (entries: EnvAppKey[]) => {
      const existingKeys = await queryClient.fetchQuery({
        queryKey: APP_KEYS_QUERY_KEY,
        queryFn: fetchAppKeys,
        staleTime: 0,
        retry: false,
      });
      const failed: EnvAppKey[] = [];
      let overridden = false;
      for (const entry of entries) {
        try {
          const result = await saveAppKey({
            name: entry.name,
            value: entry.value,
            label: existingKeys.find((key) => key.name === entry.name)?.label ?? entry.name,
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
        setFormError(t("appKeys.form.batchFailed", { saved, count: failed.length }));
      } else {
        closeForm();
      }
      if (saved > 0) toast.success(t("appKeys.batchSaved", { count: saved }));
      if (overridden) toast.warning(t("appKeys.batchOverridden"));
      await queryClient.invalidateQueries({ queryKey: APP_KEYS_QUERY_KEY });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const isSaving = saveMutation.isPending || batchMutation.isPending;

  const removeMutation = useMutation({
    mutationFn: deleteAppKey,
    onSuccess: async (_result, removedName) => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: APP_KEYS_QUERY_KEY });
      toast.success(t("appKeys.removed", { name: removedName }));
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
      const parsed = parseAppKeysEnv(envContent);
      if (parsed.error) {
        const { line, reason, detail } = parsed.error;
        setFormError(
          t("appKeys.form.envError", {
            line,
            reason: detail ?? t(`appKeys.form.envErrors.${reason}`),
          }),
        );
        return;
      }
      if (parsed.entries.length === 0) {
        setFormError(t("appKeys.form.envEmpty"));
        return;
      }
      batchMutation.mutate(parsed.entries);
      return;
    }
    const trimmedName = name.trim();
    const nameError = appKeyNameError(trimmedName);
    if (nameError) {
      setFormError(nameError);
      return;
    }
    if (!value) {
      setFormError(t("appKeys.form.valueRequired"));
      return;
    }
    saveMutation.mutate({ name: trimmedName, label: label.trim() || trimmedName, value });
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
            label={t("appKeys.form.back")}
            icon={<ArrowLeft />}
            onClick={closeForm}
            disabled={isSaving}
          />
          <SheetTitle className="flex-1 truncate text-title text-foreground">
            {form.mode === "add"
              ? t("appKeys.form.titleAdd")
              : t("appKeys.form.titleReplace", { name: form.name })}
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
              <TabsList aria-label={t("appKeys.form.inputMethod")}>
                <TabsTrigger value="single" disabled={isSaving}>
                  {t("appKeys.form.singleKey")}
                </TabsTrigger>
                <TabsTrigger value="env" disabled={isSaving}>
                  {t("appKeys.form.pasteEnv")}
                </TabsTrigger>
              </TabsList>
            )}
            <TabsContent value="single" className="space-y-4">
              <Field>
                <FieldLabel htmlFor={`${uid}-app-key-label`}>
                  {t("appKeys.form.labelField")}
                </FieldLabel>
                <Input
                  id={`${uid}-app-key-label`}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t("appKeys.form.labelPlaceholder")}
                  className="w-full"
                  autoFocus={form.mode === "add"}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-app-key-name`}>
                  {t("appKeys.form.nameField")}
                </FieldLabel>
                <Input
                  id={`${uid}-app-key-name`}
                  value={name}
                  onChange={(e) => setName(e.target.value.toUpperCase())}
                  placeholder={t("appKeys.form.namePlaceholder")}
                  disabled={form.mode === "replace"}
                  className="w-full font-mono"
                />
                <p className="mt-1 text-aux text-muted-foreground">{t("appKeys.form.nameHint")}</p>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-app-key-value`}>
                  {t("appKeys.form.valueField")}
                </FieldLabel>
                <Input
                  id={`${uid}-app-key-value`}
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="off"
                  className="w-full"
                  autoFocus={form.mode === "replace"}
                />
                <p className="mt-1 text-aux text-muted-foreground">{t("appKeys.form.valueHint")}</p>
              </Field>
            </TabsContent>
            {form.mode === "add" && (
              <TabsContent value="env">
                <Field>
                  <FieldLabel htmlFor={`${uid}-app-keys-env`}>
                    {t("appKeys.form.envContent")}
                  </FieldLabel>
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
                    {t("appKeys.form.envHint")}
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
          <p className="text-ui text-muted-foreground">{t("appKeys.form.consent")}</p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={closeForm}
              disabled={isSaving}
            >
              {t("appKeys.form.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={isSaving}>
              {isSaving ? t("appKeys.form.saving") : t("appKeys.form.save")}
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
          {t("appKeys.title")}
        </SheetTitle>
        <Button type="button" size="sm" onClick={() => openForm({ mode: "add" })}>
          <Plus data-icon="inline-start" aria-hidden />
          {t("appKeys.add")}
        </Button>
        <IconButton size="sm" label={t("appKeys.form.close")} icon={<X />} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {keysQuery.isLoading ? (
          <div className="flex flex-col gap-2" role="status" aria-label={t("appKeys.loading")}>
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : keysQuery.isError ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertTitle>{t("appKeys.errorTitle")}</AlertTitle>
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
                {t("page.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : keys.length === 0 ? (
          <EmptyState className="rounded-8 border border-dashed border-border bg-surface/50">
            <EmptyStateIcon>
              <KeyRound aria-hidden />
            </EmptyStateIcon>
            <EmptyStateTitle>{t("appKeys.emptyTitle")}</EmptyStateTitle>
            <p className="text-ui text-muted-foreground">{t("appKeys.emptyBody")}</p>
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
                      <Badge variant="warning" title={t("appKeys.overriddenHint")}>
                        {t("appKeys.overridden")}
                      </Badge>
                    ) : (
                      <>
                        <span className="font-mono" aria-hidden>
                          ••••••••
                        </span>
                        <span className="sr-only">{t("appKeys.valueHidden")}</span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openForm({ mode: "replace", name: key.name, label: key.label })}
                  >
                    {t("appKeys.replace")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRemoving(key)}
                  >
                    {t("appKeys.remove")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <RomeConfirmDialog
        open={removing !== null}
        title={t("appKeys.removeTitle", { name: removing?.name ?? "" })}
        description={t("appKeys.removeBody")}
        destructive
        confirmLabel={t("appKeys.remove")}
        confirmDisabled={removeMutation.isPending}
        onConfirm={() => {
          if (removing) removeMutation.mutate(removing.name);
        }}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
