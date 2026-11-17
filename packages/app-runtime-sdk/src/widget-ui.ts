// A card an app describes as data instead of shipping a web component, so the
// dashboard and the iOS app can both draw it natively. The shape is a subset
// of A2UI v0.9 (https://a2ui.org): a flat list of components that name their
// children by id, values that are literals or `{ path }` JSON Pointers into a
// data model, and buttons that dispatch an event. Rome adds what A2UI leaves
// to the host: the data model is filled from the app's own API (`bind`), a
// button's event is a POST to that API or answers the turn that waits on the
// card, and a text may name one of Rome's own strings, which each reader
// translates.

import { z } from "zod";

/** The components a described card may use. `Text`, `Image`, `Row`,
 *  `Column`, `List`, `Button`, `ChoicePicker` and `TextField` are A2UI's
 *  basic catalog; `Stat`, `Progress`, `Chart` and `Markdown` are Rome's. */
export const WIDGET_UI_COMPONENTS = [
  "Text",
  "Markdown",
  "Stat",
  "Chart",
  "List",
  "Row",
  "Column",
  "Image",
  "Progress",
  "Button",
  "ChoicePicker",
  "TextField",
] as const;

/** Rome's own strings a card may name with `{ string }`. Each reader shows
 *  them in the guardian's language. `connect`, `notNow` and
 *  `deviceConnectNote` are the device connect card's. */
export const WIDGET_UI_STRINGS = [
  "send",
  "dismiss",
  "typeOwn",
  "addOwn",
  "typeAnswer",
  "optional",
  "connect",
  "notNow",
  "deviceConnectNote",
] as const;

/** The icons a card may name: a `Stat`'s label, or a `Text` or `Row`, such
 *  as a list's row. Each reader draws its own glyph for the name. */
export const WIDGET_UI_ICONS = [
  "moon",
  "heart",
  "steps",
  "flame",
  "run",
  "map-pin",
  "clock",
  "calendar",
  "info",
  "alert",
] as const;

export type WidgetUiIcon = (typeof WIDGET_UI_ICONS)[number];

/** The most bars a `Chart` draws. */
export const WIDGET_UI_CHART_MAX_POINTS = 14;

/** Whether `href` is a link a card may open: an `https:` page, or a place in
 *  the maps app (`maps://`). A press opens it; the card's owner hears nothing. */
export function isWidgetHref(href: string): boolean {
  return /^https:\/\/[^/]/.test(href) || /^maps:\/\/./.test(href);
}

/** Where a `Stat`'s value sits against its usual range: `normal` inside it,
 *  `low` under it, `high` over it, or null when the value is not a number.
 *  Each reader draws the verdict, so the card's author never writes it. */
export function widgetStatTone(
  value: unknown,
  range: { low: number; high: number },
): "low" | "normal" | "high" | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < range.low ? "low" : value > range.high ? "high" : "normal";
}

export type WidgetUiStringName = (typeof WIDGET_UI_STRINGS)[number];

/** Button events Rome handles itself rather than posting to the app. Only a
 *  card the agent waits on may use them: `rome:answer` sends the card's
 *  `context` as the guardian's answer, `rome:dismiss` declines it. */
export const WIDGET_UI_HOST_EVENTS = ["rome:answer", "rome:dismiss"] as const;

export type WidgetUiComponentName = (typeof WIDGET_UI_COMPONENTS)[number];

/** A JSON Pointer (RFC 6901) into the card's data model. Inside a `List`
 *  item, a path without a leading `/` is read from that item. */
export interface WidgetUiPath {
  path: string;
}

export type WidgetUiString = string | WidgetUiPath | { string: WidgetUiStringName };
export type WidgetUiNumber = number | WidgetUiPath;

/** Either fixed child ids, or one child drawn once per element of the array
 *  at `path`. */
export type WidgetUiChildren = string[] | { componentId: string; path: string };

/**
 * A button's event. `name` is a path in the app's own API, relative to
 * `/api/apps/<appId>/`, such as `"meals/42/eaten"`. A press POSTs `context`,
 * with its paths read, as the JSON body, then reads every `bind` again. A
 * press says nothing in the chat and does not wake the agent. On a card the
 * agent waits on, `name` may instead be one of {@link WIDGET_UI_HOST_EVENTS}.
 */
export interface WidgetUiAction {
  /** Each `context` value is a literal string, number or boolean, a list, or
   *  a `{ path }`, as A2UI allows. */
  event: { name: string; context?: Record<string, WidgetUiContextValue> };
}

export type WidgetUiContextValue = string | number | boolean | unknown[] | WidgetUiPath;

interface Common {
  id: string;
}

/**
 * A rule an input or a button must pass, as A2UI's `checks`. Only two of
 * A2UI's functions are allowed, since every reader evaluates them itself:
 * `required` (a non-empty string or list at `args.value`) and `or` (any of
 * `args.values`). A button whose checks fail is disabled.
 */
export interface WidgetUiCheck {
  condition: WidgetUiCondition;
  message: string;
}

export type WidgetUiCondition =
  | { call: "required"; args: { value: WidgetUiPath } }
  | { call: "or"; args: { values: WidgetUiCondition[] } };

export type WidgetUiComponent =
  | (Common & {
      component: "Text";
      text: WidgetUiString;
      variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body";
      /** Rome's: a callout, drawn as a tinted strip with a small icon. */
      tone?: "info" | "warning" | "success";
      /** Rome's: an icon before the text. */
      icon?: WidgetUiIcon;
      /** Rome's: a link a press opens ({@link isWidgetHref}). */
      href?: string;
    })
  | (Common & {
      /**
       * Markdown text: paragraphs, headings, lists, quotes, code and tables,
       * with bold, italics and inline code. Readers
       * draw a link as its text and an image as its description, and show raw
       * HTML, math and diagrams as their source, so it never opens or loads
       * anything.
       */
      component: "Markdown";
      text: WidgetUiString;
    })
  | (Common & {
      component: "Stat";
      label: WidgetUiString;
      value: WidgetUiString | WidgetUiNumber;
      unit?: WidgetUiString;
      caption?: WidgetUiString;
      /** The usual range, in the value's unit. Each reader says whether a
       *  number `value` is inside it, under it or over it. */
      range?: { low: number; high: number };
      /** An icon before the label. */
      icon?: WidgetUiIcon;
    })
  | (Common & {
      /** Bars, one per point, such as a week of sleep. Literal values only. */
      component: "Chart";
      kind: "bar";
      /** At most {@link WIDGET_UI_CHART_MAX_POINTS}. `highlight` marks a bar,
       *  such as today (`accent`) or an outlier (`warning`). */
      points: { label: string; value: number; highlight?: "accent" | "warning" }[];
      unit?: WidgetUiString;
      caption?: WidgetUiString;
    })
  | (Common & {
      component: "Progress";
      /** Between 0 and `max`. */
      value: WidgetUiNumber;
      /** Default 1. */
      max?: WidgetUiNumber;
      label?: WidgetUiString;
    })
  | (Common & {
      component: "Image";
      /** An `https:` URL, or a path to one. Readers draw nothing for any
       *  other value, so an image never reads the instance with the
       *  guardian's session. */
      url: WidgetUiString;
      description?: WidgetUiString;
      fit?: "contain" | "cover" | "fill" | "none" | "scaleDown";
      variant?: "icon" | "avatar" | "smallFeature" | "mediumFeature" | "largeFeature" | "header";
    })
  | (Common & {
      component: "Row" | "Column";
      children: WidgetUiChildren;
      /** Rome's, on a Row only: an icon before its children. */
      icon?: WidgetUiIcon;
      /** Rome's, on a Row only: a link a press opens ({@link isWidgetHref}). */
      href?: string;
      justify?:
        | "center"
        | "end"
        | "spaceAround"
        | "spaceBetween"
        | "spaceEvenly"
        | "start"
        | "stretch";
      align?: "start" | "center" | "end" | "stretch";
    })
  | (Common & {
      component: "List";
      children: WidgetUiChildren;
      direction?: "vertical" | "horizontal";
      align?: "start" | "center" | "end" | "stretch";
    })
  | (Common & {
      component: "Button";
      /** The id of the component drawn inside the button, usually a `Text`. */
      child: string;
      action: WidgetUiAction;
      variant?: "default" | "primary" | "borderless";
      checks?: WidgetUiCheck[];
    })
  | (Common & {
      component: "ChoicePicker";
      label?: WidgetUiString;
      /** `mutuallyExclusive` (default) picks one, `multipleSelection` any. */
      variant?: "mutuallyExclusive" | "multipleSelection";
      /** `description` is Rome's: a line under the option's label. */
      options: { label: WidgetUiString; value: string; description?: WidgetUiString }[];
      /** The picked values, a list of strings the picker writes to. */
      value: WidgetUiPath;
      /** Rome's: a value a pick empties, so the last of two inputs edited
       *  wins, such as the "type your own" text beside a single choice. */
      clears?: WidgetUiPath;
    })
  | (Common & {
      component: "TextField";
      label: WidgetUiString;
      /** The text, which the field writes to. */
      value: WidgetUiPath;
      variant?: "shortText" | "longText";
      /** Rome's: shown in the empty field. */
      placeholder?: WidgetUiString;
      /** Rome's: a value typing empties, as for `ChoicePicker`. */
      clears?: WidgetUiPath;
    });

/**
 * A card described as data. The component with id `"root"` is drawn first.
 * `bind` fills the data model: each key is a JSON Pointer the response is
 * stored at, and each value a GET path in the app's own API, such as
 * `{ "/today": "logs/2026-11-11" }`. The card reads its data every time it
 * is drawn, so it shows the app's data as it stands, not as it stood when
 * shown.
 */
export interface WidgetUi {
  components: WidgetUiComponent[];
  /** The data model the card starts from, before any `bind` is read. */
  data?: Record<string, unknown>;
}

const PathSchema = z.object({ path: z.string() }).strict();
const Str = z.union([
  z.string(),
  PathSchema,
  z.object({ string: z.enum(WIDGET_UI_STRINGS) }).strict(),
]);
const ConditionSchema: z.ZodType<WidgetUiCondition> = z.lazy(() =>
  z.union([
    z
      .object({ call: z.literal("required"), args: z.object({ value: PathSchema }).strict() })
      .strict(),
    z
      .object({
        call: z.literal("or"),
        args: z.object({ values: z.array(ConditionSchema).min(1) }).strict(),
      })
      .strict(),
  ]),
);
const Checks = z.array(z.object({ condition: ConditionSchema, message: z.string() }).strict());
const Num = z.union([z.number(), PathSchema]);
const Children = z.union([
  z.array(z.string()),
  z.object({ componentId: z.string(), path: z.string() }).strict(),
]);
const common = { id: z.string().min(1) };
const Icon = z.enum(WIDGET_UI_ICONS);
const Href = z.string().refine(isWidgetHref, "must be an https: or maps:// link");

// A2UI's function calls (`{ call }`) are left out on purpose: the iOS app
// does not evaluate them, and a card must draw the same on every reader.
const ComponentSchema = z.discriminatedUnion("component", [
  z
    .object({
      ...common,
      component: z.literal("Text"),
      text: Str,
      variant: z.enum(["h1", "h2", "h3", "h4", "h5", "caption", "body"]).optional(),
      tone: z.enum(["info", "warning", "success"]).optional(),
      icon: Icon.optional(),
      href: Href.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      component: z.literal("Markdown"),
      text: Str,
    })
    .strict(),
  z
    .object({
      ...common,
      component: z.literal("Stat"),
      label: Str,
      value: z.union([z.string(), z.number(), PathSchema]),
      unit: Str.optional(),
      caption: Str.optional(),
      range: z
        .object({ low: z.number(), high: z.number() })
        .strict()
        .refine((r) => r.low <= r.high, "low must not be over high")
        .optional(),
      icon: Icon.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      component: z.literal("Chart"),
      kind: z.literal("bar"),
      points: z
        .array(
          z
            .object({
              label: z.string(),
              value: z.number(),
              highlight: z.enum(["accent", "warning"]).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(WIDGET_UI_CHART_MAX_POINTS),
      unit: Str.optional(),
      caption: Str.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      component: z.literal("Progress"),
      value: Num,
      max: Num.optional(),
      label: Str.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      component: z.literal("Image"),
      url: z.union([z.string().regex(/^https:\/\/[^/]/, "must be an https: URL"), PathSchema]),
      description: Str.optional(),
      fit: z.enum(["contain", "cover", "fill", "none", "scaleDown"]).optional(),
      variant: z
        .enum(["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"])
        .optional(),
    })
    .strict(),
  ...(["Row", "Column"] as const).map((name) =>
    z
      .object({
        ...common,
        component: z.literal(name),
        children: Children,
        ...(name === "Row" ? { icon: Icon.optional(), href: Href.optional() } : {}),
        justify: z
          .enum(["center", "end", "spaceAround", "spaceBetween", "spaceEvenly", "start", "stretch"])
          .optional(),
        align: z.enum(["start", "center", "end", "stretch"]).optional(),
      })
      .strict(),
  ),
  z
    .object({
      ...common,
      component: z.literal("List"),
      children: Children,
      direction: z.enum(["vertical", "horizontal"]).optional(),
      align: z.enum(["start", "center", "end", "stretch"]).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      component: z.literal("Button"),
      child: z.string(),
      action: z
        .object({
          event: z
            .object({
              name: z.string().min(1),
              context: z
                .record(
                  z.string(),
                  z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), PathSchema]),
                )
                .optional(),
            })
            .strict(),
        })
        .strict(),
      variant: z.enum(["default", "primary", "borderless"]).optional(),
      checks: Checks.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      component: z.literal("ChoicePicker"),
      label: Str.optional(),
      variant: z.enum(["mutuallyExclusive", "multipleSelection"]).optional(),
      options: z
        .array(z.object({ label: Str, value: z.string(), description: Str.optional() }).strict())
        .min(1),
      value: PathSchema,
      clears: PathSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      component: z.literal("TextField"),
      label: Str,
      value: PathSchema,
      variant: z.enum(["shortText", "longText"]).optional(),
      placeholder: Str.optional(),
      clears: PathSchema.optional(),
    })
    .strict(),
]);

const WidgetUiSchema = z
  .object({
    components: z.array(ComponentSchema).min(1),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** An app API path a card may GET or POST, such as `days/2026-11-11`:
 *  `/`-separated segments of letters, digits and `-_.~`, none of them `.` or
 *  `..`. Anything else, such as `%2e%2e`, a backslash, a scheme or a query,
 *  could resolve outside the app once a browser normalizes the URL. */
export function isWidgetAppPath(path: string): boolean {
  return path
    .split("/")
    .every((segment) => /^[A-Za-z0-9_~.-]+$/.test(segment) && segment !== "." && segment !== "..");
}

/**
 * Checks a described card and its bindings. Returns the problems, or an empty
 * list when every reader can draw it: known components only, unique ids, a
 * `"root"`, every child id present, no cycle, and every API path inside the
 * app. `waits` says the agent waits on the card, which allows the
 * {@link WIDGET_UI_HOST_EVENTS}. A card with problems shows nowhere.
 */
export function checkWidgetUi(
  ui: unknown,
  bind: unknown = {},
  options: { waits?: boolean } = {},
): string[] {
  const parsed = WidgetUiSchema.safeParse(ui);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `ui.${i.path.join(".")}: ${i.message}`);
  }
  const problems: string[] = [];
  const components = parsed.data.components as WidgetUiComponent[];
  const byId = new Map<string, WidgetUiComponent>();
  for (const c of components) {
    if (byId.has(c.id)) problems.push(`component id "${c.id}" is used twice`);
    byId.set(c.id, c);
  }
  if (!byId.has("root")) problems.push('no component has the id "root"');
  for (const c of components) {
    for (const child of childIds(c)) {
      if (!byId.has(child)) problems.push(`"${c.id}" names a child "${child}" that does not exist`);
    }
    if (c.component === "Button") {
      const name = c.action.event.name;
      const hostEvent = (WIDGET_UI_HOST_EVENTS as readonly string[]).includes(name);
      if (hostEvent && !options.waits) {
        problems.push(`"${c.id}" sends "${name}", which only a card the agent waits on may send`);
      } else if (!hostEvent && !isWidgetAppPath(name)) {
        problems.push(`"${c.id}" posts to "${name}", which is not a path in the app's API`);
      }
    }
  }
  if (problems.length === 0 && hasCycle(byId)) problems.push("the components contain a cycle");
  if (problems.length === 0) problems.push(...linkProblems(components, byId));

  const bindParsed = z.record(z.string(), z.string()).safeParse(bind);
  if (!bindParsed.success) {
    problems.push("bind must map JSON Pointers to API paths");
  } else {
    for (const [pointer, path] of Object.entries(bindParsed.data)) {
      if (!pointer.startsWith("/") || pointer.length < 2) {
        problems.push(`bind key "${pointer}" is not a JSON Pointer such as "/today"`);
      }
      if (!isWidgetAppPath(path))
        problems.push(`bind "${pointer}" reads "${path}", which is not a path in the app's API`);
    }
  }
  return problems;
}

const INTERACTIVE = new Set(["Button", "ChoicePicker", "TextField"]);

/** Whether a component's subtree, itself included, holds one `test`
 *  matches. A child may sit under several parents, so each id is answered
 *  once and remembered: the walk stays linear in the components, never in
 *  the paths. Cycles are refused before it runs. */
function subtreeFinder(
  byId: Map<string, WidgetUiComponent>,
  test: (c: WidgetUiComponent) => boolean,
): (id: string) => boolean {
  const known = new Map<string, boolean>();
  const has = (id: string): boolean => {
    const seen = known.get(id);
    if (seen !== undefined) return seen;
    const c = byId.get(id);
    const found = !!c && (test(c) || childIds(c).some(has));
    known.set(id, found);
    return found;
  };
  return has;
}

const hasHref = (c: WidgetUiComponent) =>
  (c.component === "Text" || c.component === "Row") && c.href !== undefined;

/**
 * A press opens a link or sends an event, never both: a component with an
 * `href` holds no Button, ChoicePicker or TextField, and a Button's label
 * holds no link. A Stat's `range` is judged against a number, so its value
 * is a number or a path to one.
 */
function linkProblems(
  components: WidgetUiComponent[],
  byId: Map<string, WidgetUiComponent>,
): string[] {
  const problems: string[] = [];
  const holdsPressable = subtreeFinder(byId, (k) => INTERACTIVE.has(k.component) || hasHref(k));
  const holdsLink = subtreeFinder(byId, hasHref);
  for (const c of components) {
    if (hasHref(c) && childIds(c).some(holdsPressable)) {
      problems.push(
        `"${c.id}" has an href and holds a control or another link: a press would do two things`,
      );
    }
    if (c.component === "Button" && holdsLink(c.child)) {
      problems.push(
        `"${c.id}" is a Button whose label holds an href: a press would both send an event and open the link`,
      );
    }
    if (c.component === "Stat" && c.range && typeof c.value === "string") {
      problems.push(
        `"${c.id}" has a range, so its value must be a plain number in the range's unit, or a path to one`,
      );
    }
  }
  return problems;
}

/** The ids a component names as its children. */
export function childIds(c: WidgetUiComponent): string[] {
  if (c.component === "Button") return [c.child];
  if (c.component === "Row" || c.component === "Column" || c.component === "List") {
    return Array.isArray(c.children) ? c.children : [c.children.componentId];
  }
  return [];
}

function hasCycle(byId: Map<string, WidgetUiComponent>): boolean {
  const state = new Map<string, "open" | "done">();
  const visit = (id: string): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "open") return true;
    state.set(id, "open");
    const c = byId.get(id);
    if (c && childIds(c).some(visit)) return true;
    state.set(id, "done");
    return false;
  };
  return [...byId.keys()].some(visit);
}
