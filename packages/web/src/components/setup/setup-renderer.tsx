/**
 * the standard setup renderers + a per-`(service, state)` custom
 * component registry. The renderers narrate a setup entirely from its
 * server-authored payload (the HARD RULE: payloads are semantically complete).
 * A custom component overrides RENDERING ONLY for a specific `(service, status)`
 * pair — it receives the same complete state and handlers, so any surface can
 * still fall back to the standard renderer.
 */

import { useId, useState, type ComponentType, type ReactElement } from "react";
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
import type { SetupState, SetupView, SetupViewLink, SetupViewStep } from "@/lib/setup-api";

/** Everything a renderer (standard or custom) needs. */
export interface SetupRenderProps {
  service: string;
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

/** Key format for the custom-component registry: `"<service>:<status>"`. */
export type SetupComponentRegistry = Record<string, ComponentType<SetupRenderProps>>;

export interface SetupRendererProps extends SetupRenderProps {
  labels?: Partial<SetupLabels>;
  registry?: SetupComponentRegistry;
}

/** Render a setup state: a registered custom component for this
 *  `(service, status)` if one exists, else the standard renderer. */
export function SetupRenderer(props: SetupRendererProps): ReactElement {
  const { registry, labels, ...rest } = props;
  const Custom = registry?.[`${rest.service}:${rest.state.status}`];
  if (Custom) return <Custom {...rest} />;
  return <StandardSetupRenderer {...rest} labels={labels} />;
}

export function StandardSetupRenderer(
  props: SetupRenderProps & { labels?: Partial<SetupLabels> },
): ReactElement {
  const labels = { ...DEFAULT_LABELS, ...props.labels };
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
          >
            {labels.continue}
          </a>
        </div>
      );
    case "done":
      return (
        <div className="space-y-1" data-testid="setup-done">
          {state.conferral.summary ? (
            <ViewBody view={state.conferral.summary} />
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
  const form = state.status === "awaiting-input" ? state.form : { fields: [] };
  const error = state.status === "awaiting-input" ? state.error : undefined;
  const [values, setValues] = useState<Record<string, string>>({});
  const uid = useId();

  const setField = (name: string, value: string): void =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const complete = form.fields.every((f) => (values[f.name] ?? "").trim().length > 0);

  return (
    <div className="space-y-3" data-testid="setup-input">
      {form.instructions && <p className="text-aux text-muted-foreground">{form.instructions}</p>}
      <StepList steps={form.steps} />
      <LinkList links={form.links} />
      {form.fields.map((field) => (
        <Field key={field.name}>
          <FieldLabel htmlFor={`${uid}-${field.name}`}>{field.label}</FieldLabel>
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
                {field.options.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : field.format === "multiline" ? (
            <textarea
              id={`${uid}-${field.name}`}
              className="w-full rounded-4 border border-border-subtle bg-surface px-2 py-1 text-body"
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
      ))}
      {form.note && <p className="text-aux text-muted-foreground">{form.note}</p>}
      {error && <p className="text-aux text-destructive-fg">{error}</p>}
      {props.error && <p className="text-aux text-destructive-fg">{props.error}</p>}
      <Button size="sm" onClick={() => props.onSubmit(values)} disabled={props.busy || !complete}>
        {labels.submit}
      </Button>
    </div>
  );
}

/** Render a view payload: title, paragraphs, a QR image, links, and a step
 *  checklist. */
function ViewBody({ view }: { view: SetupView }): ReactElement {
  return (
    <div className="space-y-2">
      {view.title && <p className="text-ui text-foreground">{view.title}</p>}
      {view.body?.map((paragraph, i) => (
        <p key={i} className="text-aux text-muted-foreground">
          {paragraph}
        </p>
      ))}
      {view.qr && (
        <img
          src={view.qr}
          alt={view.title ?? "QR code"}
          className="h-44 w-44 rounded-8 border border-border bg-white p-2"
        />
      )}
      <StepList steps={view.steps} />
      <LinkList links={view.links} />
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
