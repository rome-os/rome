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
 *  basic catalog; `Stat` and `Progress` are Rome's. */
export const WIDGET_UI_COMPONENTS = [
  "Text",
  "Stat",
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
 *  them in the guardian's language. */
export const WIDGET_UI_STRINGS = [
  "send",
  "dismiss",
  "typeOwn",
  "addOwn",
  "typeAnswer",
  "optional",
] as const;

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
  event: { name: string; context?: Record<string, unknown> };
}

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
    })
  | (Common & {
      component: "Stat";
      label: WidgetUiString;
      value: WidgetUiString | WidgetUiNumber;
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

// A2UI's function calls (`{ call }`) are left out on purpose: the iOS app
// does not evaluate them, and a card must draw the same on every reader.
const ComponentSchema = z.discriminatedUnion("component", [
  z
    .object({
      ...common,
      component: z.literal("Text"),
      text: Str,
      variant: z.enum(["h1", "h2", "h3", "h4", "h5", "caption", "body"]).optional(),
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
              context: z.record(z.string(), z.unknown()).optional(),
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
  const segments = path.split("/");
  if (HOST_APP_ROUTES.has(segments[0] ?? "")) return false;
  return segments.every(
    (segment) => /^[A-Za-z0-9_~.-]+$/.test(segment) && segment !== "." && segment !== "..",
  );
}

/** Routes Rome serves itself under `/api/apps/<appId>/`, ahead of the app's
 *  own API. A card reaches none of them. */
const HOST_APP_ROUTES: ReadonlySet<string> = new Set(["publish", "icon", "manifest"]);

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
