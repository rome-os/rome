export const NAMESPACES = [
  "common",
  "settings",
  "auth",
  "activity",
  "routines",
  "chat",
  "envoys",
  "people",
  "apps",
  "files",
  "inbox",
  "onboard",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** Every namespace of one language. A bundle that misses a namespace fails the typecheck. */
export type LocaleBundle = Record<Namespace, object>;
