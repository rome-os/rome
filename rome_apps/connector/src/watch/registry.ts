// Every source this app can watch, one adapter each. The actions and the
// shared code find a source here and never name one. Adding a source is a new
// adapter folder, one line below, and its events under `eventSources` in
// app.yaml, which registry.test.ts checks.

import { createGithubAdapter } from "./adapters/github/index.js";
import { gmailAdapter } from "./adapters/gmail/index.js";
import { calendarAdapter } from "./adapters/googlecalendar/index.js";
import { linearAdapter } from "./adapters/linear/index.js";
import { notionAdapter } from "./adapters/notion/index.js";
import { outlookAdapter } from "./adapters/outlook/index.js";
import { stripeAdapter } from "./adapters/stripe/index.js";
import type { WatchAdapter } from "./types.js";

export const ADAPTERS: readonly WatchAdapter[] = [
  createGithubAdapter(),
  gmailAdapter,
  calendarAdapter,
  linearAdapter,
  outlookAdapter,
  notionAdapter,
  stripeAdapter,
];

export const adapterOf = (source: string) => ADAPTERS.find((a) => a.source === source);

/** Whether a bus event matches a pattern: an exact name, or a prefix ending in `*`. */
const matches = (pattern: string, eventName: string) =>
  pattern.endsWith("*") ? eventName.startsWith(pattern.slice(0, -1)) : pattern === eventName;

/** The adapter that delivers a bus event, for a `defer` waiting on it. */
export const adapterForEvent = (eventName: string) =>
  ADAPTERS.find((a) => a.events.some((pattern) => matches(pattern, eventName)));

/** Every bus event the adapters deliver, as their patterns name them. */
export const deliveredEvents = () => ADAPTERS.flatMap((a) => a.events);
