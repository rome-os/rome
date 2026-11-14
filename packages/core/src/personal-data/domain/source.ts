// What a personal-data source declares: its types, each with a shape, a canonical
// unit and a rollup rule. A source's table is data, not logic. Concept:
// docs/personal-data.md.

/** How a type's readings are stored. A source joins the store only with these. */
export type Shape = "bucket" | "sample" | "record";

/** The width of a bucket. */
export type Resolution = "hour" | "day";

/** How a type's values combine over a window: added up, or averaged. */
export type Rollup = "sum" | "avg";

/** A unit a query may ask for, as `value * factor + offset` of the canonical unit. */
export interface UnitConversion {
  name: string;
  factor: number;
  offset?: number;
}

export interface TypeSpec {
  type: string;
  shape: Shape;
  /** The one unit the store keeps the type in. */
  unit: string;
  /** The bucket widths a device sends, for a bucket type. */
  resolutions?: readonly Resolution[];
  rollup: Rollup;
  /**
   * Which end of a reading places it in a window and a bucket. `end` for a
   * reading named by when it ends, such as a night of sleep by its wake time.
   * Default `start`.
   */
  bucketBy?: "start" | "end";
  /** Other units a query may convert to. */
  conversions?: readonly UnitConversion[];
  /** A short line for the Agent. */
  note?: string;
}

export interface SourceSpec {
  source: string;
  title: string;
  /** The source's text for the Agent in the catalog. */
  note: string;
  types: readonly TypeSpec[];
  /** The metadata keys a reading may carry. Others are dropped. */
  metadataKeys: readonly string[];
  /** How an Agent reads the source live, when the device is reachable. */
  live?: { how: string; when: string };
}

export function typeSpec(source: SourceSpec, type: string): TypeSpec | undefined {
  return source.types.find((spec) => spec.type === type);
}
