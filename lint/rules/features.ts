// Import rules for domains laid out as `<domain>/<feature>` under
// packages/core/src. The domain root, meaning the files directly in it plus
// model/ and infrastructure/, is the service the domain provides. Each feature
// is a subfolder with an index.ts, and leaving a feature out is skipping its
// route mount. Connections lays out each kind of connection the same way under
// connections/kinds/, so the rules here judge a kind as they judge a feature. A
// kind is not a feature of Connections, but leaving it out is likewise skipping
// its mount. rules/layers.ts holds a feature or kind to entering through
// index.ts. The layout: DEVELOPMENT.md, "Established patterns".

import type { Import, ImportRule, ListedCrossing } from "../import-rules.js";

/** Domains laid out as `<domain>/<feature>`, each with its features. A domain adopting the layout joins this list. */
export const FEATURED_DOMAINS: Record<string, readonly string[]> = {
  people: ["guardian-profile", "link-code", "person-history", "phone-book"],
};

/** Kinds of connection laid out as mountable parts under connections/kinds/. A kind joins this list when it moves to the layout. */
export const CONNECTION_KINDS: readonly string[] = [];

/**
 * Every domain with mountable parts, mapped to each part's folder under the
 * domain: a feature such as `phone-book`, or a kind of connection such as
 * `kinds/discord`.
 */
export const MOUNTED_PARTS: Record<string, readonly string[]> = {
  ...FEATURED_DOMAINS,
  connections: CONNECTION_KINDS.map((kind) => `kinds/${kind}`),
};

/**
 * The domain and part of a src-relative path, with the path's remaining
 * segments, or null outside every domain in MOUNTED_PARTS. `part` is null for
 * the domain root. partOf("connections/kinds/discord/http/x.ts") returns
 * { domain: "connections", part: "kinds/discord", rest: ["http", "x.ts"] }
 * once discord is listed.
 */
export function partOf(
  path: string,
  mounted: Record<string, readonly string[]> = MOUNTED_PARTS,
): { domain: string; part: string | null; rest: string[] } | null {
  const [domain, ...below] = path.split("/");
  const parts = mounted[domain];
  if (parts === undefined) return null;
  const inside = below.join("/");
  const part = parts.find((p) => inside.startsWith(`${p}/`)) ?? null;
  return { domain, part, rest: part === null ? below : below.slice(part.split("/").length) };
}

/**
 * Files outside a domain that may use one of its features, by feature, each
 * with why. Every other file outside the domain reaches a feature only from
 * the wiring or a test.
 */
const FEATURE_USERS: Record<string, { files: readonly string[]; why: string }> = {
  "people/link-code": {
    files: ["connections/kinds/discord/discord.ts", "connections/kinds/feishu/feishu.ts"],
    why: "Discord and Feishu hold back a message that is a link code, so it never reaches a chat",
  },
  "people/person-history": {
    files: ["api/routes/assistants.ts"],
    why: "an assistant's page sends to an account the way a person's page does, through directPlace",
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

/** Where a src-relative path sits in a domain with mountable parts, or null outside every one. */
function placeOf(path: string): Place | null {
  const found = partOf(path);
  if (found === null || found.rest.length === 0) return null;
  if (found.part === null) return { domain: found.domain, feature: null, index: false };
  return {
    domain: found.domain,
    feature: found.part,
    index: found.rest.length === 1 && /^index\.tsx?$/.test(found.rest[0]),
  };
}

/** Which folder of a feature a path sits in: application/, http/, actions/, or another. */
function adapterSide(path: string): { feature: string; side: string } | null {
  const found = partOf(path);
  if (found?.part == null) return null;
  return { feature: `${found.domain}/${found.part}`, side: found.rest[0] };
}

export function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

/** Whether `from` is the feature's own routes, the wiring, a test, or a listed user of the feature. */
function mayUse(from: string, domain: string, feature: string): boolean {
  if (from.startsWith(`api/routes/${domain}/${feature}/`)) return true;
  if (from === `api/routes/${domain}/${feature}.ts`) return true;
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
    description: `Leaving a feature out is skipping its route mount, so outside its domain only the feature's own routes (api/routes/<domain>/<feature>), the wiring and tests use it. The listed exceptions: ${usersList()}.`,
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
      "A feature or kind of connection serves apps through http/ and agents through actions/, both over the same use cases, so in a featured domain or Connections only a file in an http/ folder imports hono. Tests may, to mount routes.",
    rejects: (imp) =>
      imp.kind === "package" &&
      (imp.specifier === "hono" || imp.specifier.startsWith("hono/")) &&
      MOUNTED_PARTS[imp.from.split("/")[0]] !== undefined &&
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
    why: "A person on the People page carries each account's send state and last activity, which person history reads, until the phone book gets them through the people root.",
  },
  {
    rule: "drizzle-stays-in-infrastructure",
    from: "connections/app-connection-access.ts",
    to: "drizzle-orm",
    ticket: "ZHA-217",
    why: "What an app may do through a connection is read from the database, until that goes through a repository in connections/infrastructure/.",
  },
  {
    rule: "drizzle-stays-in-infrastructure",
    from: "connections/chat-addresses.ts",
    to: "drizzle-orm",
    ticket: "ZHA-217",
    why: "The adapters' address store reads and writes chat addresses, until it moves into connections/infrastructure/.",
  },
  {
    rule: "drizzle-stays-in-infrastructure",
    from: "connections/chat-ids.ts",
    to: "drizzle-orm",
    ticket: "ZHA-217",
    why: "The chat and message ids each platform keeps are read from the database, until that goes through a repository in connections/infrastructure/.",
  },
  {
    rule: "drizzle-stays-in-infrastructure",
    from: "connections/device/repository.ts",
    to: "drizzle-orm",
    ticket: "ZHA-217",
    why: "The device connections repository reads and writes its tables, until it moves into connections/infrastructure/.",
  },
  {
    rule: "drizzle-stays-in-infrastructure",
    from: "connections/oauth/rome-cloud-oauth.ts",
    to: "drizzle-orm",
    ticket: "ZHA-217",
    why: "A Rome Cloud sign-in keeps its pending attempts in the database, until that goes through a repository in connections/infrastructure/.",
  },
  {
    rule: "drizzle-stays-in-infrastructure",
    from: "connections/repository-db.ts",
    to: "drizzle-orm",
    ticket: "ZHA-217",
    why: "The connections repository keeps connections and their grants in the database, until it moves into connections/infrastructure/.",
  },
];
