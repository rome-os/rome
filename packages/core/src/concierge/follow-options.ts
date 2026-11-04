// A follow's options as the guardian's wishes in words. The catalog of the
// connection declares each option (its label, its values' labels, its
// default); this renders the values a follow chose, for triage to read. Nothing
// here filters an event: the options are guidance, never rules in code.

import type { ConciergeFollowOptionDto } from "@rome/api-types/concierge";

/** An option's value: what the follow stored when it fits, else the default. */
export function optionValue(
  option: ConciergeFollowOptionDto,
  stored: unknown,
): string | boolean | string[] {
  if (option.type === "boolean") return typeof stored === "boolean" ? stored : option.default;
  if (option.type === "list") {
    return Array.isArray(stored)
      ? stored.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : option.default;
  }
  return typeof stored === "string" && option.values?.some((v) => v.value === stored)
    ? stored
    : option.default;
}

/**
 * Each option of a follow as one line, such as "Ignore these people:
 * dependabot[bot]" or "Mail sent to: Me directly". An empty list says nothing,
 * so it is left out.
 */
export function renderOptions(
  options: readonly ConciergeFollowOptionDto[],
  values: Record<string, unknown>,
): string[] {
  return options.flatMap((option) => {
    const value = optionValue(option, values[option.key]);
    if (option.type === "boolean") return [`${option.label}: ${value === true ? "yes" : "no"}`];
    if (option.type === "list") {
      const items = value as string[];
      return items.length > 0 ? [`${option.label}: ${items.join(", ")}`] : [];
    }
    const chosen = option.values?.find((v) => v.value === value)?.label ?? String(value);
    return [`${option.label}: ${chosen}`];
  });
}
