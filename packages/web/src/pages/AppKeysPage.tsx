import { appKeyNameError } from "@rome/api-types/app-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, KeyRound, Plus, RefreshCw, X } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Field, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { AppKeysBadge } from "@/components/connections/app-keys-row";
import {
  APP_KEYS_QUERY_KEY,
  type AppKeyDto,
  deleteAppKey,
  fetchAppKeys,
  saveAppKey,
} from "@/lib/app-keys-api";
import { PageShell, PageBody } from "@/shell/PageShell";

/**
 * App keys management page (`/settings/connections/app-keys`).
 *
 * The Connections list links here the way it routes to a service's detail page:
 * the list stays a directory, the ceremony lives on the page. Header (badge +
 * title + primary "Add key"), an inline form panel while adding or replacing,
 * and a key table — name and label, a masked value column, row actions.
 */

const BACK_TO_LIST = "/settings/connections";

/** Blank form for "add"; prefilled name+label (value always retyped) for
 * "replace". The value is write-only end to end: the API never returns it, so
 * the form never has anything to show back. */
type FormState = { mode: "add" } | { mode: "replace"; name: string; label: string };

export default function AppKeysPage() {
  const { t } = useTranslation("settings");
  const uid = useId();
  const queryClient = useQueryClient();
  const keysQuery = useQuery({ queryKey: APP_KEYS_QUERY_KEY, queryFn: fetchAppKeys });

  const [form, setForm] = useState<FormState | null>(null);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AppKeyDto | null>(null);

  const openForm = (next: FormState) => {
    setForm(next);
    setLabel(next.mode === "replace" ? next.label : "");
    setName(next.mode === "replace" ? next.name : "");
    setValue("");
    setFormError(null);
  };
  const closeForm = () => {
    setForm(null);
    setValue("");
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

  return (
    <PageShell>
      <PageBody className="max-w-3xl">
        <div className="space-y-4">
          <Link
            to={BACK_TO_LIST}
            className="inline-flex items-center gap-2 text-ui text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t("appKeys.back")}
          </Link>
          <div className="flex flex-wrap items-start gap-3">
            <AppKeysBadge />
            <div className="min-w-0 flex-1">
              <h1 className="text-title text-foreground">{t("appKeys.title")}</h1>
            </div>
            {form === null && (
              <Button type="button" size="sm" onClick={() => openForm({ mode: "add" })}>
                <Plus aria-hidden />
                {t("appKeys.add")}
              </Button>
            )}
          </div>
        </div>

        {form !== null && (
          <form
            className="space-y-4 rounded-8 border border-border bg-surface p-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-section text-foreground">
                {form.mode === "add"
                  ? t("appKeys.form.titleAdd")
                  : t("appKeys.form.titleReplace", { name: form.name })}
              </h2>
              <IconButton
                size="sm"
                label={t("appKeys.form.close")}
                icon={<X />}
                onClick={closeForm}
              />
            </div>
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
            <div className="grid gap-4 sm:grid-cols-2">
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
            </div>
            {formError && <p className="text-body text-destructive">{formError}</p>}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-body text-muted-foreground">{t("appKeys.form.consent")}</p>
              <div className="flex shrink-0 gap-2">
                <Button type="button" variant="outline" size="sm" onClick={closeForm}>
                  {t("appKeys.form.cancel")}
                </Button>
                <Button type="submit" size="sm" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? t("appKeys.form.saving") : t("appKeys.form.save")}
                </Button>
              </div>
            </div>
          </form>
        )}

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
                <RefreshCw aria-hidden />
                {t("page.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : keys.length === 0 ? (
          form === null && (
            <EmptyState className="rounded-8 border border-dashed border-border bg-surface/50">
              <EmptyStateIcon>
                <KeyRound aria-hidden />
              </EmptyStateIcon>
              <EmptyStateTitle>{t("appKeys.emptyTitle")}</EmptyStateTitle>
              <p className="text-body text-muted-foreground">{t("appKeys.emptyBody")}</p>
            </EmptyState>
          )
        ) : (
          <div className="overflow-hidden rounded-8 border border-border bg-surface">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">{t("appKeys.table.key")}</TableHead>
                  <TableHead>{t("appKeys.table.value")}</TableHead>
                  <TableHead className="pr-4">
                    <span className="sr-only">{t("appKeys.table.actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.name}>
                    {/* w-full + max-w-0 lets the key column flex while truncate
                        still applies inside a table cell. */}
                    <TableCell className="w-full max-w-0 py-3 pl-4">
                      <p className="truncate text-ui text-foreground" title={key.label}>
                        {key.label}
                      </p>
                      {key.label !== key.name && (
                        <p
                          className="truncate font-mono text-aux text-muted-foreground"
                          title={key.name}
                        >
                          {key.name}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="py-3">
                      {key.overridden ? (
                        <Badge variant="warning" title={t("appKeys.overriddenHint")}>
                          {t("appKeys.overridden")}
                        </Badge>
                      ) : (
                        <>
                          <span
                            className="font-mono text-body tracking-widest text-muted-foreground"
                            aria-hidden
                          >
                            ••••••••
                          </span>
                          <span className="sr-only">{t("appKeys.valueHidden")}</span>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="py-3 pr-4">
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            openForm({ mode: "replace", name: key.name, label: key.label })
                          }
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

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
      </PageBody>
    </PageShell>
  );
}
