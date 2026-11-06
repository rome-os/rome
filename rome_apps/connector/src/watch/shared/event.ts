// Building an event in the common shape: reading raw JSON safely, the labels
// that apply, and the cleaned subject and excerpt. Every adapter's normalizer
// builds its events here, so the rules for text and labels are one.

import { buildTopic } from "../../api/topic.js";
import type { AddressedTo, Json, Normalized, WatchTrigger } from "../types.js";
import { excerptOf, subjectOf } from "./text.js";

/** The bus name of a trigger's raw event. */
export const eventNameOf = (trigger: Pick<WatchTrigger, "provider" | "type">) =>
  buildTopic(trigger.provider, trigger.type);

export const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : undefined;
export const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
export const drop = (reason: string): Normalized => ({ keep: false, reason });

export const KIND_OFF = "not a kind this follow has on";

/** The labels that apply, each once. */
export const labelsOf = (...labels: (string | false | undefined)[]): string[] => [
  ...new Set(labels.filter((label): label is string => Boolean(label))),
];

/** What a normalizer knows of one event, before its text is cleaned. */
export interface EventFields {
  actor?: string;
  subject?: string;
  url?: string;
  /** The text an excerpt is cut from. */
  text?: string;
  byYou: boolean;
  addressedTo: AddressedTo;
  labels: (string | false | undefined)[];
}

/** An event kept in the common shape, its subject and excerpt cleaned. */
export function keep(source: string, id: string, kind: string, fields: EventFields): Normalized {
  const subject = subjectOf(fields.subject);
  const excerpt = excerptOf(fields.text);
  return {
    keep: true,
    event: {
      id: `${source}:${id}`,
      source,
      kind,
      ...(fields.actor ? { actor: fields.actor } : {}),
      ...(subject ? { subject } : {}),
      ...(fields.url ? { url: fields.url } : {}),
      ...(excerpt ? { excerpt } : {}),
      byYou: fields.byYou,
      addressedTo: fields.addressedTo,
      labels: labelsOf(...fields.labels),
    },
  };
}
