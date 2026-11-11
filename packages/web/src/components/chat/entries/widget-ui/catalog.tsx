// Rome's A2UI catalog: the components a card described as data may use
// (`WIDGET_UI_COMPONENTS` in @rome-os/app-runtime), drawn with the dashboard's
// own tokens. The six from A2UI's basic catalog keep its schemas, so a card
// reads as A2UI; `Stat` and `Progress` are Rome's.
import {
  ButtonApi,
  Catalog,
  ColumnApi,
  CommonSchemas,
  type ComponentApi,
  ImageApi,
  ListApi,
  RowApi,
  TextApi,
} from "@a2ui/web_core/v0_9";
import { createComponentImplementation } from "@a2ui/react/v0_9";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
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

const ProgressApi = {
  name: "Progress",
  schema: Base.extend({
    value: CommonSchemas.DynamicNumber,
    max: CommonSchemas.DynamicNumber.optional(),
    label: CommonSchemas.DynamicString.optional(),
  }).strict(),
};

const textClass: Record<string, string> = {
  h1: "text-title",
  h2: "text-title",
  h3: "text-section",
  h4: "text-section",
  h5: "text-section",
  caption: "text-aux text-muted-foreground",
  body: "text-ui",
};

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

const Text = createComponentImplementation(TextApi, ({ props }) => (
  <span className={cn("min-w-0 text-foreground", textClass[props.variant ?? "body"])}>
    {shown(props.text)}
  </span>
));

const Stat = createComponentImplementation(StatApi, ({ props }) => (
  <div className="flex min-w-0 flex-col">
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

const Progress = createComponentImplementation(ProgressApi, ({ props }) => {
  const max = typeof props.max === "number" && props.max > 0 ? props.max : 1;
  const value = typeof props.value === "number" ? props.value : 0;
  const share = Math.max(0, Math.min(1, value / max));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {props.label ? <span className="text-aux text-muted-foreground">{props.label}</span> : null}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={props.label ?? undefined}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
});

const Image = createComponentImplementation(ImageApi, ({ props }) => (
  <img
    src={props.url}
    alt={props.description ?? ""}
    className={cn(
      "max-w-full rounded-8",
      props.variant === "icon" && "size-5",
      props.variant === "avatar" && "size-8 rounded-full",
    )}
    style={{ objectFit: props.fit === "scaleDown" ? "scale-down" : (props.fit ?? "cover") }}
  />
));

const Row = createComponentImplementation(RowApi, ({ props, buildChild }) => (
  <div
    className={cn(
      "flex min-w-0 flex-row flex-wrap gap-3",
      justifyClass[props.justify ?? "start"],
      alignClass[props.align ?? "center"],
    )}
  >
    {children(props.children as Child[], buildChild)}
  </div>
));

const Column = createComponentImplementation(ColumnApi, ({ props, buildChild }) => (
  <div
    className={cn(
      "flex min-w-0 flex-col gap-2",
      justifyClass[props.justify ?? "start"],
      alignClass[props.align ?? "stretch"],
    )}
  >
    {children(props.children as Child[], buildChild)}
  </div>
));

const List = createComponentImplementation(ListApi, ({ props, buildChild }) => (
  <div
    role="list"
    className={cn(
      "flex min-w-0 gap-1",
      props.direction === "horizontal" ? "flex-row overflow-x-auto" : "flex-col",
      alignClass[props.align ?? "stretch"],
    )}
  >
    {children(props.children as Child[], buildChild).map((node, i) => (
      <div role="listitem" key={i} className="min-w-0">
        {node}
      </div>
    ))}
  </div>
));

const WidgetButton = createComponentImplementation(ButtonApi, ({ props, buildChild }) => (
  <Button
    size="sm"
    variant={
      props.variant === "primary" ? "default" : props.variant === "borderless" ? "ghost" : "outline"
    }
    className="self-start"
    onClick={() => void props.action?.()}
  >
    {buildChild(props.child as string)}
  </Button>
));

export const romeWidgetCatalog = new Catalog(ROME_WIDGET_CATALOG_ID, [
  Text,
  Stat,
  Progress,
  Image,
  Row,
  Column,
  List,
  WidgetButton,
  // @a2ui/react types its schemas with the page's zod 4 and web_core with
  // its own zod 3. Only the types differ: @a2ui/react calls no zod at run
  // time, and every schema here is web_core's.
] as unknown as ComponentApi[]);
