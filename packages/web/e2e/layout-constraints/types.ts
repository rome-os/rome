/**
 * The shape of a layout constraint spec. An agent writes these from the
 * component code, not from a screenshot: the code already says which edges are
 * meant to line up (a `pl-3` that matches a bubble's `px-3`, a negative margin
 * that pulls an icon onto an edge), and the spec turns that intent into a
 * relationship a script can measure.
 */

/**
 * Picks elements. Fields combine as AND. Prefer, in order: `role` and `name`,
 * then `testid`, then `component` (with `props` and `nth`), and `css` last.
 */
export type Locator = {
  /** ARIA role, explicit or implicit for the common tags. */
  role?: string;
  /** Accessible name: `aria-label`, else the trimmed text. Exact match. */
  name?: string;
  testid?: string;
  /** React component name. Resolves to the component's rendered root elements. Dev builds only. */
  component?: string;
  /** Matches the component's props by strict equality. Needs `component`. */
  props?: Record<string, string | number | boolean | null>;
  css?: string;
  /** Only matches inside a match of this locator. */
  within?: Locator;
  /** Keeps only the nth match (0-based, negative counts from the end). */
  nth?: number;
};

/**
 * What part of an element to measure.
 * - `box`: the border box.
 * - `content`: the border box minus border and padding.
 * - `text`: the union of the element's rendered text line boxes, falling back to `content`.
 * - `ink`: the union of its SVG drawings' geometry, falling back to `text`.
 */
export type Level = "box" | "content" | "text" | "ink";

export type Edge = "left" | "right" | "top" | "bottom" | "centerX" | "centerY" | "width" | "height";

export type Subject = {
  locator: Locator;
  level: Level;
  edge: Edge;
  /**
   * Every match takes part, not just the first. A scope with fewer than two
   * values in total is skipped; a single-element subject that does not resolve
   * inside a resolved scope marks the spec stale.
   */
  all?: boolean;
};

export type Constraint = {
  id: string;
  /** The intent, and where in the code it comes from. */
  why: string;
  /** Each match is one group. The constraint applies only where the scope renders. */
  scope: Locator;
  /** Every value these subjects produce, within one scope match, must be equal. */
  subjects: Subject[];
  /** Applies only when the scope's box is at least this wide, for container-query layouts. */
  scopeMinWidth?: number;
  /** Allowed spread in CSS px. Defaults to 1. */
  tolerance?: number;
};

export type Rect = { left: number; top: number; right: number; bottom: number };

/** `ref` indexes the page-side list of measured elements, for scrolling one into view. */
export type Measured = { label: string; value: number; rect: Rect; ref: number };

export type Finding =
  | { kind: "violation"; id: string; why: string; spread: number; measured: Measured[] }
  | { kind: "stale"; id: string; why: string; detail: string; scopeRect: Rect; ref: number };
