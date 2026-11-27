/**
 * the standard setup renderers + an optional custom `presenting` component.
 * The renderers narrate a setup entirely from its server-authored payload (the
 * HARD RULE: payloads are semantically complete). The custom component
 * overrides RENDERING ONLY for the `presenting` state — it receives the same
 * complete state and handlers, so any surface can still fall back to the
 * standard renderer.
 */

import { useId, useState, type ComponentType, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isElectronShell } from "@/lib/electron-shell";
import { isInternalHref, toInternalPath } from "@/lib/internal-href";
import type {
  SetupFormFieldOption,
  SetupState,
  SetupView,
  SetupViewLink,
  SetupViewStep,
} from "@/lib/setup-api";

/** Everything a renderer (standard or custom) needs. */
export interface SetupRenderProps {
  state: SetupState;
  busy: boolean;
  error: string | null;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
  onRetry: () => void;
}

/** Generic button/heading labels; server copy carries everything else. */
export interface SetupLabels {
  submit: string;
  cancel: string;
  retry: string;
  continue: string;
  connected: string;
  failed: string;
  cancelled: string;
}

const DEFAULT_LABELS: SetupLabels = {
  submit: "Continue",
  cancel: "Cancel",
  retry: "Try again",
  continue: "Continue",
  connected: "Connected",
  failed: "Something went wrong",
  cancelled: "Cancelled",
};

function normalizeOption(opt: SetupFormFieldOption): { value: string; label: string } {
  return typeof opt === "string" ? { value: opt, label: opt } : opt;
}

export interface SetupRendererProps extends SetupRenderProps {
  labels?: Partial<SetupLabels>;
  /** Custom renderer for the `presenting` state. */
  renderPresenting?: ComponentType<SetupRenderProps>;
}

/** Render a setup state: the custom `presenting` component when one is given
 *  and the setup is presenting, else the standard renderer. */
export function SetupRenderer(props: SetupRendererProps): ReactElement {
  const { renderPresenting: Presenting, labels, ...rest } = props;
  if (Presenting && rest.state.status === "presenting") return <Presenting {...rest} />;
  return <StandardSetupRenderer {...rest} labels={labels} />;
}

export function StandardSetupRenderer(
  props: SetupRenderProps & { labels?: Partial<SetupLabels> },
): ReactElement {
  const { t } = useTranslation("settings");
  const labels: SetupLabels = {
    submit: t("connections.setup.actions.submit", { defaultValue: DEFAULT_LABELS.submit }),
    cancel: t("connections.setup.actions.cancel", { defaultValue: DEFAULT_LABELS.cancel }),
    retry: t("connections.setup.actions.retry", { defaultValue: DEFAULT_LABELS.retry }),
    continue: t("connections.setup.actions.continue", { defaultValue: DEFAULT_LABELS.continue }),
    connected: t("connections.setup.actions.connected", { defaultValue: DEFAULT_LABELS.connected }),
    failed: t("connections.setup.actions.failed", { defaultValue: DEFAULT_LABELS.failed }),
    cancelled: t("connections.setup.actions.cancelled", { defaultValue: DEFAULT_LABELS.cancelled }),
    ...props.labels,
  };
  const { state } = props;
  switch (state.status) {
    case "awaiting-input":
      return <AwaitingInput {...props} labels={labels} />;
    case "presenting":
      return (
        <div className="space-y-2" data-testid="setup-presenting">
          <ViewBody view={state.view} />
          {props.error && <p className="text-aux text-destructive-fg">{props.error}</p>}
          <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
            {labels.cancel}
          </Button>
        </div>
      );
    case "awaiting-redirect":
      return (
        <div className="space-y-2" data-testid="setup-redirect">
          <a
            href={state.url}
            className="text-info-fg underline underline-offset-2"
            rel="noreferrer"
            onClick={(event) => {
              // The desktop window has no keychain or platform authenticator,
              // so a sign-in with a passkey cannot finish there. `window.open`
              // reaches the shell, which hands the URL to the system browser.
              if (!isElectronShell()) return;
              event.preventDefault();
              window.open(state.url);
            }}
          >
            {labels.continue}
          </a>
        </div>
      );
    case "done":
      return (
        <div className="space-y-1" data-testid="setup-done">
          {state.grant.summary ? (
            <ViewBody view={state.grant.summary} />
          ) : (
            <p className="text-aux text-success-fg">{labels.connected}</p>
          )}
        </div>
      );
    case "failed":
      return (
        <div className="space-y-2" data-testid="setup-failed">
          <p className="text-aux text-destructive-fg">{state.reason || labels.failed}</p>
          <Button size="sm" onClick={props.onRetry} disabled={props.busy}>
            {labels.retry}
          </Button>
        </div>
      );
    case "cancelled":
      return (
        <div className="space-y-2" data-testid="setup-cancelled">
          <p className="text-aux text-muted-foreground">{labels.cancelled}</p>
          <Button size="sm" onClick={props.onRetry} disabled={props.busy}>
            {labels.retry}
          </Button>
        </div>
      );
    default: {
      const exhaustive: never = state;
      return <>{JSON.stringify(exhaustive)}</>;
    }
  }
}

/** The awaiting-input renderer owns the controlled field values. */
function AwaitingInput(props: SetupRenderProps & { labels: SetupLabels }): ReactElement {
  const { state, labels } = props;
  const { t } = useTranslation("settings");
  const form = state.status === "awaiting-input" ? state.form : { fields: [] };
  const error = state.status === "awaiting-input" ? state.error : undefined;
  const [values, setValues] = useState<Record<string, string>>({});
  const uid = useId();

  const translateFormText = (subkey: string, fallback: string): string =>
    form.id
      ? t(`connections.setup.forms.${form.id}.${subkey}`, { defaultValue: fallback })
      : fallback;

  const setField = (name: string, value: string): void =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const complete = form.fields.every((f) => (values[f.name] ?? "").trim().length > 0);
  const instructions = form.instructions
    ? translateFormText("instructions", form.instructions)
    : undefined;
  const note = form.note ? translateFormText("note", form.note) : undefined;

  return (
    <div className="space-y-3" data-testid="setup-input">
      {instructions && <p className="text-aux text-muted-foreground">{instructions}</p>}
      <StepList steps={form.steps} />
      <LinkList links={form.links} />
      {form.fields.map((field) => {
        const fieldLabel = translateFormText(`fields.${field.name}.label`, field.label);
        return (
          <Field key={field.name}>
            <FieldLabel htmlFor={`${uid}-${field.name}`}>{fieldLabel}</FieldLabel>
            {field.options ? (
              <Select
                /* "" keeps the Select controlled from the first render while
                   still showing the placeholder — it reads as "nothing picked". */
                value={values[field.name] ?? ""}
                onValueChange={(value) => setField(field.name, value)}
              >
                <SelectTrigger id={`${uid}-${field.name}`} className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((rawOpt) => {
                    const opt = normalizeOption(rawOpt);
                    const optLabel = translateFormText(
                      `fields.${field.name}.options.${opt.value}`,
                      opt.label,
                    );
                    return (
                      <SelectItem key={opt.value} value={opt.value}>
                        {optLabel}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            ) : field.format === "multiline" ? (
              <textarea
                id={`${uid}-${field.name}`}
                className="w-full rounded-4 border border-border-subtle bg-surface px-2 py-1 text-ui"
                value={values[field.name] ?? ""}
                onChange={(e) => setField(field.name, e.target.value)}
              />
            ) : (
              <Input
                id={`${uid}-${field.name}`}
                type={field.secret ? "password" : "text"}
                value={values[field.name] ?? ""}
                onChange={(e) => setField(field.name, e.target.value)}
              />
            )}
          </Field>
        );
      })}
      {note && <p className="text-aux text-muted-foreground">{note}</p>}
      {error && <p className="text-aux text-destructive-fg">{error}</p>}
      {props.error && <p className="text-aux text-destructive-fg">{props.error}</p>}
      <Button size="sm" onClick={() => props.onSubmit(values)} disabled={props.busy || !complete}>
        {labels.submit}
      </Button>
    </div>
  );
}

/** Format known timestamp params (such as `expiresAt`) in the user's locale
 *  instead of exposing raw UTC ISO timestamps in localized copy. */
function formatViewParams(
  params: Record<string, string> | undefined,
  language: string,
): Record<string, string> {
  if (!params) return {};
  const out: Record<string, string> = { ...params };
  if (out.expiresAt) {
    const parsed = new Date(out.expiresAt);
    if (!Number.isNaN(parsed.getTime())) {
      try {
        out.expiresAt = new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(parsed);
      } catch {
        // Fall back to the raw value if Intl rejects the locale tag.
      }
    }
  }
  return out;
}

/** Render a view payload: title, paragraphs, a QR image, links, and a step
 *  checklist. */
function ViewBody({ view }: { view: SetupView }): ReactElement {
  const { t, i18n } = useTranslation("settings");
  const formattedParams = formatViewParams(view.params, i18n.language);
  const translateViewText = (subkey: string, fallback: string): string =>
    view.id
      ? t(`connections.setup.views.${view.id}.${subkey}`, {
          ...formattedParams,
          defaultValue: fallback,
        })
      : fallback;

  const title = view.title ? translateViewText("title", view.title) : undefined;
  const body = view.body?.map((item, i) => {
    const key = typeof item === "string" ? String(i) : item.id;
    const fallback = typeof item === "string" ? item : item.text;
    return { key, text: translateViewText(`body.${key}`, fallback) };
  });
  const links = view.links?.map((link) =>
    link.id ? { ...link, label: translateViewText(`links.${link.id}`, link.label) } : link,
  );

  return (
    <div className="space-y-2">
      {title && <p className="text-ui text-foreground">{title}</p>}
      {body?.map((paragraph) => (
        <p key={paragraph.key} className="text-aux text-muted-foreground">
          {paragraph.text}
        </p>
      ))}
      {view.qr && (
        <img
          src={view.qr}
          alt={title ?? "QR code"}
          className="h-44 w-44 rounded-8 border border-border bg-white p-2"
        />
      )}
      <StepList steps={view.steps} />
      <LinkList links={links} />
    </div>
  );
}

/** A numbered checklist — shared by presented views and prompt-form preambles. */
function StepList({ steps }: { steps?: SetupViewStep[] }): ReactElement | null {
  if (!steps || steps.length === 0) return null;
  return (
    <ol className="list-inside list-decimal space-y-1 text-aux text-muted-foreground">
      {steps.map((step, i) => (
        <li key={i} className={step.done ? "line-through opacity-60" : undefined}>
          {step.text}
        </li>
      ))}
    </ol>
  );
}

const SETUP_LINK_CLASS = "text-info-fg underline underline-offset-2";

/**
 * Labeled links — shared by presented views and prompt-form preambles.
 *
 * Payloads mix destinations: Telegram sends the guardian to t.me, LinkedIn to
 * `/desktop`, this dashboard's own view of the browser Rome signs in through.
 * A new tab is right for the first and right for the second in a browser, where
 * the panel stays readable in the tab behind it.
 *
 * The Mac app has no tabs, and its shell hands every new-window request to
 * Safari, which holds no Rome session — so there a link home arrives at a
 * sign-in wall. Only that shell switches to in-app routing; a browser keeps the
 * new tab it already opens.
 */
function LinkList({ links }: { links?: SetupViewLink[] }): ReactElement | null {
  if (!links || links.length === 0) return null;
  const keepInApp = isElectronShell();
  return (
    <ul className="space-y-1 text-aux">
      {links.map((link) => (
        <li key={link.url}>
          {keepInApp && isInternalHref(link.url) ? (
            <Link to={toInternalPath(link.url)} className={SETUP_LINK_CLASS}>
              {link.label}
            </Link>
          ) : (
            <a href={link.url} target="_blank" rel="noreferrer" className={SETUP_LINK_CLASS}>
              {link.label}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
