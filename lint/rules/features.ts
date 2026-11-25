// Import rules for domains laid out as `<domain>/<feature>` under
// packages/core/src. The domain root, meaning the files directly in it plus
// model/ and infrastructure/, is the service the domain provides. Each feature
// is a subfolder with an index.ts, and leaving a feature out is deleting its
// entry in the wiring's features list. rules/layers.ts holds a feature to entering through index.ts. The layout: DEVELOPMENT.md, "Established patterns".

import type { Import, ImportRule, ListedCrossing } from "../import-rules.js";

/** Domains laid out as `<domain>/<feature>`, each with its features. A domain adopting the layout joins this list. */
export const FEATURED_DOMAINS: Record<string, readonly string[]> = {
  people: ["guardian-profile", "person-history", "phone-book"],
};

/**
 * Files outside a domain that may use one of its features, by feature, each
 * with why. Every other file outside the domain reaches a feature only from
 * the wiring or a test.
 */
const FEATURE_USERS: Record<string, { files: readonly string[]; why: string }> = {
  "people/person-history": {
    files: ["api/routes/assistants.ts"],
    why: "an assistant's page sends to an account through directPlace, and answers with person history's respondToSend so every send the dashboard reads has one shape",
  },
  "people/guardian-profile": {
    files: ["api/routes/onboard.ts", "api/routes/cloud-login.ts", "app-host/guardian-profile.ts"],
    why: "onboarding, Rome Cloud sign-in and apps set the guardian's name and background",
  },
};

/** The wiring builds the object graph and mounts the routes. It mirrors rules/wiring.ts, minus api/routes/. */
const WIRING_FILES = ["index.ts", "chats-wiring.ts", "api/index.ts", "api/deps.ts"];
const WIRING_FOLDERS = ["wiring", "bin", "test"];

type Place =
  | { domain: string; feature: string; index: boolean }
  | { domain: string; feature: null; index: false };

/** Where a src-relative path sits in a featured domain, or null outside every one. */
function placeOf(path: string): Place | null {
  const [domain, next, after] = path.split("/");
  const features = FEATURED_DOMAINS[domain];
  if (features === undefined || next === undefined) return null;
  if (!features.includes(next) || after === undefined)
    return { domain, feature: null, index: false };
  return { domain, feature: next, index: /^index\.tsx?$/.test(after) };
}

/** Which folder of a feature a path sits in: application/, http/, actions/, or another. */
function adapterSide(path: string): { feature: string; side: string } | null {
  const place = placeOf(path);
  if (place?.feature == null) return null;
  return { feature: `${place.domain}/${place.feature}`, side: path.split("/")[2] };
}

export function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

/** Whether `from` is the wiring, a test, or a listed user of the feature. */
function mayUse(from: string, domain: string, feature: string): boolean {
  if (WIRING_FILES.includes(from) || WIRING_FOLDERS.includes(from.split("/")[0])) return true;
  if (isTest(from)) return true;
  return FEATURE_USERS[`${domain}/${feature}`]?.files.includes(from) ?? false;
}

function featureImport(
  imp: Import,
): { from: Place | null; to: Place & { feature: string } } | null {
  if (imp.kind !== "file") return null;
  const to = placeOf(imp.to);
  if (to?.feature == null) return null;
  return { from: placeOf(imp.from), to };
}

function usersList(): string {
  return Object.entries(FEATURE_USERS)
    .map(([feature, { files, why }]) => `${feature} from ${files.join(", ")}, because ${why}`)
    .join("; ");
}

export const featureRules: ImportRule[] = [
  {
    name: "domain-root-imports-no-feature",
    description:
      "The domain root is the service every feature builds on, so a file at the root of a featured domain, in its model/ or in its infrastructure/ imports none of its features.",
    rejects: (imp) => {
      const found = featureImport(imp);
      return (
        found !== null && found.from?.domain === found.to.domain && found.from.feature === null
      );
    },
  },
  {
    name: "features-import-no-sibling",
    description:
      "Each feature can be left out on its own, so a file in one feature of a domain imports no other feature of it. A feature builds on the domain root.",
    rejects: (imp) => {
      const found = featureImport(imp);
      return (
        found?.from?.domain === found?.to.domain &&
        found?.from?.feature != null &&
        found.from.feature !== found.to.feature
      );
    },
  },
  {
    name: "features-used-from-wiring",
    description: `Leaving a feature out is deleting its entry in the wiring's features list, so outside its domain only the wiring and tests use it. The listed exceptions: ${usersList()}.`,
    rejects: (imp) => {
      const found = featureImport(imp);
      if (found === null || found.from?.domain === found.to.domain) return false;
      return !mayUse(imp.from, found.to.domain, found.to.feature);
    },
  },
  {
    name: "adapters-import-inward",
    description:
      "A feature's use cases in application/ serve apps through http/ and agents through actions/, so application/ imports neither adapter, and neither adapter imports the other.",
    rejects: (imp) => {
      if (imp.kind !== "file") return false;
      const from = adapterSide(imp.from);
      const to = adapterSide(imp.to);
      if (from === null || to === null || from.feature !== to.feature) return false;
      const sides = ["application", "http", "actions"];
      if (!sides.includes(from.side) || (to.side !== "http" && to.side !== "actions")) return false;
      return from.side !== to.side;
    },
  },
  {
    name: "hono-stays-in-http",
    description:
      "A feature serves apps through http/ and agents through actions/, both over the same use cases, so in a featured domain only a file in an http/ folder imports hono. Tests may, to mount routes.",
    rejects: (imp) =>
      imp.kind === "package" &&
      (imp.specifier === "hono" || imp.specifier.startsWith("hono/")) &&
      FEATURED_DOMAINS[imp.from.split("/")[0]] !== undefined &&
      !imp.from.split("/").includes("http") &&
      !isTest(imp.from),
  },
];

/** Crossings that remain until their ticket lands. */
export const featureCrossings: ListedCrossing[] = [
  {
    rule: "features-import-no-sibling",
    from: "people/phone-book/application/resource.ts",
    to: "people/person-history/index.ts",
    ticket: "ZHA-213",
    why: "A person in the people listing carries each account's send state and last activity, which person history reads, until the phone book gets them through the people root.",
  },
];
