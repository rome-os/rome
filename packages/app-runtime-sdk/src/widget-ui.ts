// A card an app describes as data instead of shipping a web component, so the
// dashboard and the iOS app can both draw it natively. The shape is a subset
// of A2UI v0.9 (https://a2ui.org): a flat list of components that name their
// children by id, values that are literals or `{ path }` JSON Pointers into a
// data model, and buttons that dispatch an event. Rome adds two things A2UI
// leaves to the host: the data model is filled from the app's own API
// (`bind`), and a button's event is a POST to that API.

import { z } from "zod";

/** The components a described card may use. `Text`, `Image`, `Row`,
 *  `Column`, `List` and `Button` are A2UI's basic catalog; `Stat` and
 *  `Progress` are Rome's. */
export const WIDGET_UI_COMPONENTS = [
  "Text",
  "Stat",
  "List",
  "Row",
  "Column",
  "Image",
  "Progress",
  "Button",
] as const;

export type WidgetUiComponentName = (typeof WIDGET_UI_COMPONENTS)[number];

/** A JSON Pointer (RFC 6901) into the card's data model. Inside a `List`
 *  item, a path without a leading `/` is read from that item. */
export interface WidgetUiPath {
  path: string;
}

export type WidgetUiString = string | WidgetUiPath;
export type WidgetUiNumber = number | WidgetUiPath;

/** Either fixed child ids, or one child drawn once per element of the array
 *  at `path`. */
export type WidgetUiChildren = string[] | { componentId: string; path: string };

/**
 * A button's event. `name` is a path in the app's own API, relative to
 * `/api/apps/<appId>/`, such as `"meals/42/eaten"`. A press POSTs `context`,
 * with its paths read, as the JSON body, then reads every `bind` again. A
 * press says nothing in the chat and does not wake the agent.
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
}

const PathSchema = z.object({ path: z.string() }).strict();
const Str = z.union([z.string(), PathSchema]);
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
    })
    .strict(),
]);

const WidgetUiSchema = z.object({ components: z.array(ComponentSchema).min(1) }).strict();

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
 * app. A card with problems shows nowhere.
 */
export function checkWidgetUi(ui: unknown, bind: unknown = {}): string[] {
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
    if (c.component === "Button" && !isWidgetAppPath(c.action.event.name)) {
      problems.push(
        `"${c.id}" posts to "${c.action.event.name}", which is not a path in the app's API`,
      );
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
