// Rome's A2UI catalog: the components a card described as data may use
// (`WIDGET_UI_COMPONENTS` in @rome-os/app-runtime), drawn with the dashboard's
// own tokens. The components from A2UI's basic catalog keep its schemas, so
// a card reads as A2UI; `Stat`, `Progress` and `Markdown` are Rome's, and
// `TextField` adds Rome's `placeholder`.
import {
  ButtonApi,
  Catalog,
  ChoicePickerApi,
  ColumnApi,
  CommonSchemas,
  type ComponentApi,
  ImageApi,
  ListApi,
  createFunctionImplementation,
  OrImplementation,
  RequiredApi,
  RowApi,
  TextApi,
  TextFieldApi,
} from "@a2ui/web_core/v0_9";
import { createComponentImplementation } from "@a2ui/react/v0_9";
import { createContext, type ReactNode, useContext } from "react";
import Markdown from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export const ROME_WIDGET_CATALOG_ID = "https://rome.app/a2ui/catalogs/chat-widget/v1.json";

// Built from the basic catalog's own schema object so every part comes from
// the zod instance the binder reads.
const Base = TextApi.schema.omit({ text: true, variant: true });

const StatApi = {
  name: "Stat",
  schema: Base.extend({
    label: CommonSchemas.DynamicString,
    value: CommonSchemas.DynamicValue,
    unit: CommonSchemas.DynamicString.optional(),
    caption: CommonSchemas.DynamicString.optional(),
  }).strict(),
};

const MarkdownApi = {
  name: "Markdown",
  schema: Base.extend({ text: CommonSchemas.DynamicString }).strict(),
};

const ProgressApi = {
  name: "Progress",
  schema: Base.extend({
    value: CommonSchemas.DynamicNumber,
    max: CommonSchemas.DynamicNumber.optional(),
    label: CommonSchemas.DynamicString.optional(),
  }).strict(),
};

// Rome's option `description` is a dynamic string, so a bound one is read
// like the label.
const ChoiceOptionSchema = ChoicePickerApi.schema.shape.options.element.extend({
  description: CommonSchemas.DynamicString.optional(),
});

const ChoicePickerWithDescriptionsApi = {
  name: "ChoicePicker",
  schema: ChoicePickerApi.schema.extend({ options: ChoiceOptionSchema.array() }).strict(),
};

const TextFieldWithPlaceholderApi = {
  name: "TextField",
  schema: TextFieldApi.schema
    .extend({ placeholder: CommonSchemas.DynamicString.optional() })
    .strict(),
};

/** True once the card is answered or dismissed: inputs stop taking input and
 *  buttons are hidden. */
export const WidgetLockedContext = createContext(false);

/** True while a button's request is in flight: every button is disabled, so
 *  a press is sent once. */
export const WidgetBusyContext = createContext(false);

/** Rome's `clears`, by component id: the value an input empties when it is
 *  edited. A2UI's schemas have no such field, so the card hands it here. */
export const WidgetClearsContext = createContext<ReadonlyMap<string, string>>(new Map());

/** The empty value at `path`: `[]` for a list, `""` otherwise. */
function clearValue(
  dataContext: { set(path: string, value: unknown): void },
  path: string,
  list: boolean,
) {
  dataContext.set(path, list ? [] : "");
}

// One type scale, two weights: headings medium, everything else regular.
const textClass: Record<string, string> = {
  h1: "text-title",
  h2: "text-title",
  h3: "text-section",
  h4: "text-section",
  h5: "text-section",
  caption: "text-aux text-muted-foreground",
  body: "text-ui",
};

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5"]);

const justifyClass: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spaceBetween: "justify-between",
  spaceAround: "justify-around",
  spaceEvenly: "justify-evenly",
  stretch: "justify-stretch",
};

const alignClass: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
};

function shown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return value.toLocaleString();
  return typeof value === "string" ? value : JSON.stringify(value);
}

type Child = string | { id: string; basePath?: string };

function children(list: Child[] | undefined, build: (id: string, basePath?: string) => ReactNode) {
  return (list ?? []).map((child) =>
    typeof child === "string" ? build(child) : build(child.id, child.basePath),
  );
}

/** A button's label takes the button's own text colour, as on a primary
 *  button's fill, rather than the card's. */
const InButtonContext = createContext(false);

const Text = createComponentImplementation(TextApi, ({ props }) => {
  const inButton = useContext(InButtonContext);
  return (
    <span
      className={cn("min-w-0", !inButton && "text-foreground", textClass[props.variant ?? "body"])}
    >
      {shown(props.text)}
    </span>
  );
});

// A tile on a subtle fill: the label above, the value below it with its
// unit, and an optional caption such as the usual range.
const Stat = createComponentImplementation(StatApi, ({ props }) => (
  <div className="flex min-w-0 flex-col gap-1 rounded-8 bg-muted px-3 py-2">
    <span className="text-aux text-muted-foreground">{shown(props.label)}</span>
    <span className="text-title text-foreground tabular-nums">
      {shown(props.value)}
      {props.unit ? (
        <span className="ml-1 text-aux text-muted-foreground">{props.unit}</span>
      ) : null}
    </span>
    {props.caption ? <span className="text-aux text-muted-foreground">{props.caption}</span> : null}
  </div>
));

// A card opens and loads nothing: inert Markdown shows a link as its text and
// an image as its description, and draws no diagram or raw HTML.
const CardMarkdown = createComponentImplementation(MarkdownApi, ({ props }) => (
  <Markdown compact inert className="min-w-0 text-foreground">
    {shown(props.text)}
  </Markdown>
));

// The label on the left and the share on the right, above a thin track.
const Progress = createComponentImplementation(ProgressApi, ({ props }) => {
  const max = typeof props.max === "number" && props.max > 0 ? props.max : 1;
  const value = typeof props.value === "number" ? props.value : 0;
  const share = Math.max(0, Math.min(1, value / max));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-aux">
        <span className="min-w-0 text-foreground">{props.label ?? ""}</span>
        <span className="text-muted-foreground tabular-nums">{Math.round(share * 100)}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={props.label ?? undefined}
        className="h-1.5 w-full overflow-hidden rounded-full bg-border"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
});

// A2UI's `required` passes a string of spaces; the question card and the iOS
// app have always treated that as no answer.
const Required = createFunctionImplementation(RequiredApi, ({ value }) =>
  typeof value === "string"
    ? value.trim().length > 0
    : Array.isArray(value)
      ? value.length > 0
      : value !== null && value !== undefined,
);

/** An image URL a card may load: `https:` only, so it never reads the
 *  instance with the guardian's session, and loads the same on iOS. */
function httpsUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https:\/\/[^/]/.test(value) ? value : undefined;
}

const Image = createComponentImplementation(ImageApi, ({ props }) =>
  httpsUrl(props.url) === undefined ? null : (
    <img
      src={httpsUrl(props.url)}
      alt={props.description ?? ""}
      className={cn(
        "max-w-full rounded-8",
        props.variant === "icon" && "size-5",
        props.variant === "avatar" && "size-8 rounded-full",
      )}
      style={{ objectFit: props.fit === "scaleDown" ? "scale-down" : (props.fit ?? "cover") }}
    />
  ),
);

/** The type of the component with id `id`, or undefined. */
function typeOf(
  context: { surfaceComponents: { get(id: string): { type: string } | undefined } },
  id: string,
) {
  return context.surfaceComponents.get(id)?.type;
}

function variantOf(
  context: {
    surfaceComponents: { get(id: string): { properties: Record<string, unknown> } | undefined };
  },
  id: string,
) {
  const variant = context.surfaceComponents.get(id)?.properties.variant;
  return typeof variant === "string" ? variant : undefined;
}

/** The component ids a Row or Column names as its children, as the card
 *  wrote them; the resolved `children` prop holds the renderer's node ids. */
function childIdsOf(context: {
  componentModel: { properties: Record<string, unknown> };
}): string[] {
  const named = context.componentModel.properties.children;
  return Array.isArray(named) ? named.filter((id): id is string => typeof id === "string") : [];
}

const Row = createComponentImplementation(RowApi, ({ props, buildChild, context }) => {
  const ids = childIdsOf(context);
  // Numbers side by side read as an even two-column grid.
  if (ids.length > 1 && ids.every((id) => typeOf(context, id) === "Stat")) {
    return (
      <div className="grid min-w-0 grid-cols-2 gap-2">
        {children(props.children as Child[], buildChild)}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0 flex-row flex-wrap gap-3",
        justifyClass[props.justify ?? "start"],
        alignClass[props.align ?? "center"],
      )}
    >
      {children(props.children as Child[], buildChild)}
    </div>
  );
});

// Children 12 apart, except a caption right under a heading, which is its
// subtitle and sits 4 under it.
const Column = createComponentImplementation(ColumnApi, ({ props, buildChild, context }) => {
  const ids = childIdsOf(context);
  const subtitle = (i: number) =>
    i > 0 &&
    typeOf(context, ids[i] ?? "") === "Text" &&
    variantOf(context, ids[i] ?? "") === "caption" &&
    typeOf(context, ids[i - 1] ?? "") === "Text" &&
    HEADINGS.has(variantOf(context, ids[i - 1] ?? "") ?? "");
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        justifyClass[props.justify ?? "start"],
        alignClass[props.align ?? "stretch"],
      )}
    >
      {children(props.children as Child[], buildChild).map((node, i) => (
        <div
          key={i}
          className={cn("flex min-w-0 flex-col", i > 0 && (subtitle(i) ? "mt-1" : "mt-3"))}
        >
          {node}
        </div>
      ))}
    </div>
  );
});

// Rows with a hairline between them, none after the last.
const List = createComponentImplementation(ListApi, ({ props, buildChild }) =>
  props.direction === "horizontal" ? (
    <div
      role="list"
      className={cn(
        "flex min-w-0 flex-row gap-2 overflow-x-auto",
        alignClass[props.align ?? "stretch"],
      )}
    >
      {children(props.children as Child[], buildChild).map((node, i) => (
        <div role="listitem" key={i} className="min-w-0">
          {node}
        </div>
      ))}
    </div>
  ) : (
    <div
      role="list"
      className={cn(
        "flex min-w-0 flex-col divide-y divide-border",
        alignClass[props.align ?? "stretch"],
      )}
    >
      {children(props.children as Child[], buildChild).map((node, i) => (
        <div role="listitem" key={i} className="min-w-0 py-3 first:pt-0 last:pb-0">
          {node}
        </div>
      ))}
    </div>
  ),
);

const WidgetButton = createComponentImplementation(ButtonApi, ({ props, buildChild }) => {
  const locked = useContext(WidgetLockedContext);
  const busy = useContext(WidgetBusyContext);
  if (locked) return null;
  return (
    <Button
      size="sm"
      variant={
        props.variant === "primary"
          ? "default"
          : props.variant === "borderless"
            ? "ghost"
            : "outline"
      }
      className="self-start"
      disabled={busy || props.isValid === false}
      onClick={() => void props.action?.()}
    >
      <InButtonContext.Provider value={true}>
        {buildChild(props.child as string)}
      </InButtonContext.Provider>
    </Button>
  );
});

// Options read as the question card's chips: a pressed chip is picked.
const ChoicePicker = createComponentImplementation(
  ChoicePickerWithDescriptionsApi,
  ({ props, context }) => {
    const locked = useContext(WidgetLockedContext);
    const clears = useContext(WidgetClearsContext).get(context.componentModel.id);
    const picked = Array.isArray(props.value) ? (props.value as string[]) : [];
    const multi = props.variant === "multipleSelection";
    const options = (props.options ?? []) as {
      label?: unknown;
      value: string;
      description?: unknown;
    }[];
    const stacked = options.some((o) => shown(o.label).length > 32 || o.description);
    const choose = (value: string) => {
      const next = multi
        ? picked.includes(value)
          ? picked.filter((v) => v !== value)
          : [...picked, value]
        : [value];
      props.setValue?.(next);
      if (clears) clearValue(context.dataContext, clears, false);
    };
    return (
      <div
        role="group"
        aria-label={props.label ? shown(props.label) : undefined}
        className={stacked ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"}
      >
        {options.map((o) => {
          const selected = picked.includes(o.value);
          return (
            <Button
              key={o.value}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              align={stacked ? "start" : "center"}
              aria-pressed={selected}
              disabled={locked}
              onClick={() => choose(o.value)}
              className={cn(
                "h-auto min-h-[var(--control-h-sm)] min-w-0 max-w-full whitespace-normal wrap-anywhere",
                stacked && "w-full text-left",
                o.description ? "py-2" : null,
              )}
            >
              {o.description ? (
                <span className="flex min-w-0 flex-col gap-1">
                  <span>{shown(o.label)}</span>
                  <span
                    className={cn(
                      "text-aux",
                      selected ? "text-primary-foreground/80" : "text-muted-foreground",
                    )}
                  >
                    {shown(o.description)}
                  </span>
                </span>
              ) : (
                shown(o.label)
              )}
            </Button>
          );
        })}
      </div>
    );
  },
);

const TextField = createComponentImplementation(
  TextFieldWithPlaceholderApi,
  ({ props, context }) => {
    const locked = useContext(WidgetLockedContext);
    const clears = useContext(WidgetClearsContext).get(context.componentModel.id);
    const type = (text: string) => {
      props.setValue?.(text);
      if (clears && text) clearValue(context.dataContext, clears, true);
    };
    const field = {
      "aria-label": shown(props.label),
      placeholder: props.placeholder ? shown(props.placeholder) : undefined,
      value: typeof props.value === "string" ? props.value : "",
      disabled: locked,
    };
    return props.variant === "longText" ? (
      <Textarea {...field} rows={3} onChange={(e) => type(e.currentTarget.value)} />
    ) : (
      <Input {...field} onChange={(e) => type(e.currentTarget.value)} />
    );
  },
);

export const romeWidgetCatalog = new Catalog(
  ROME_WIDGET_CATALOG_ID,
  [
    Text,
    CardMarkdown,
    Stat,
    Progress,
    Image,
    Row,
    Column,
    List,
    WidgetButton,
    ChoicePicker,
    TextField,
    // @a2ui/react types its schemas with the page's zod 4 and web_core with
    // its own zod 3. Only the types differ: @a2ui/react calls no zod at run
    // time, and every schema here is web_core's.
  ] as unknown as ComponentApi[],
  [
    // The only functions a card may call, in its `checks`.
    Required,
    OrImplementation,
  ],
);
