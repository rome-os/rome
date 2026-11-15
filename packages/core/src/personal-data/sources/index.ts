import type { SourceSpec } from "../domain/source.js";
import { APPLE_HEALTH } from "./apple-health.js";

/** Every source the store accepts. An ingest for any other is refused whole. */
export const PERSONAL_DATA_SOURCES: readonly SourceSpec[] = [APPLE_HEALTH];

export function sourceSpec(source: string): SourceSpec | undefined {
  return PERSONAL_DATA_SOURCES.find((spec) => spec.source === source);
}
