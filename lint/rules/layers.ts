// Import rules for bounded contexts laid out as `<context>/<layer>` under
// packages/core/src. In a domain laid out as `<domain>/<feature>`
// (rules/features.ts), each feature and the domain root take the layers one
// level down: `<domain>/<feature>/<layer>` and `<domain>/<layer>`. The layout:
// DEVELOPMENT.md, "Established patterns".

import type { Import, ImportRule, ListedCrossing } from "../import-rules.js";
import { FEATURED_DOMAINS, isTest } from "./features.js";

/** Folders directly under src/ laid out as `<context>/<layer>`. A context adopting the layout joins this list. */
export const LAYERED_CONTEXTS = ["agent"];

type Layer = "domain" | "application" | "infrastructure" | "index" | "other";

/**
 * The context and layer of a src-relative path, or null for code outside every
 * layered context. A feature of a featured domain is a context of its own,
 * named `<domain>/<feature>`, and so is the domain root, named `<domain>`.
 */
function placeOf(path: string): { context: string; layer: Layer } | null {
  const parts = path.split("/");
  const features = FEATURED_DOMAINS[parts[0]];
  const depth = features?.includes(parts[1]) ? 2 : 1;
  if (!LAYERED_CONTEXTS.includes(parts[0]) && features === undefined) return null;
  const context = parts.slice(0, depth).join("/");
  const next = parts[depth];
  if (next === undefined) return null;
  if (next === "domain" || next === "application" || next === "infrastructure")
    return { context, layer: next };
  return { context, layer: /^index\.tsx?$/.test(next) ? "index" : "other" };
}

/** Whether a context has an index.ts as its public module: a layered context or a feature, but not a featured domain's root. */
function hasIndex(context: string): boolean {
  return LAYERED_CONTEXTS.includes(context) || context.includes("/");
}

/** For a file import from `layer`: is the target in the importer's context and one of `allowed`? */
function staysWithin(imp: Import, layer: Layer, allowed: Layer[]): boolean | null {
  if (imp.kind !== "file") return null;
  const from = placeOf(imp.from);
  if (from?.layer !== layer) return null;
  const to = placeOf(imp.to);
  return to !== null && to.context === from.context && allowed.includes(to.layer);
}

/** Whether a feature's file imports its featured domain's root or model/, which is the feature's model too. */
function readsDomainModel(imp: Import): boolean {
  if (imp.kind !== "file") return false;
  const from = placeOf(imp.from);
  const to = placeOf(imp.to);
  if (from === null || to === null || !from.context.includes("/")) return false;
  return to.context === from.context.split("/")[0] && to.layer !== "infrastructure";
}

export const layerRules: ImportRule[] = [
  {
    name: "domain-imports-domain",
    description:
      "The domain depends on nothing outward. A file in domain/ imports only its own context's domain/ and packages.",
    rejects: (imp) => staysWithin(imp, "domain", ["domain"]) === false,
  },
  {
    name: "application-imports-inward",
    description:
      "Use cases depend only on the model. A file in application/ imports only its own context's domain/, application/ and packages. A feature's model is also its domain's root and model/, short of infrastructure/. Tests may reach further, to seed and read.",
    rejects: (imp) =>
      !isTest(imp.from) &&
      staysWithin(imp, "application", ["domain", "application"]) === false &&
      !readsDomainModel(imp),
  },
  {
    name: "infrastructure-imports-inward",
    description:
      "Adapters depend inward, never on what wires them. A file in infrastructure/ never imports its own context's application/ or index.ts.",
    rejects: (imp) => staysWithin(imp, "infrastructure", ["application", "index"]) === true,
  },
  {
    name: "enter-through-index",
    description:
      "A context's index.ts is its public module. Code outside a context imports nothing of it but index.ts. A featured domain's root has no index.ts; rules/features.ts judges its features.",
    rejects: (imp) => {
      if (imp.kind !== "file") return false;
      const to = placeOf(imp.to);
      if (to === null || to.layer === "index" || !hasIndex(to.context)) return false;
      return placeOf(imp.from)?.context !== to.context;
    },
  },
  {
    name: "literal-imports-in-contexts",
    description:
      "The layer rules can only judge an import they can resolve. A dynamic import inside a layered context names its module with a string literal.",
    rejects: (imp) => imp.kind === "computed" && placeOf(imp.from) !== null,
  },
  {
    name: "drizzle-stays-in-infrastructure",
    description:
      "Only a repository talks to the database. In a layered context or a featured domain, a file outside an infrastructure/ folder never imports drizzle-orm. Tests may, to seed and read tables.",
    rejects: (imp) =>
      imp.kind === "package" &&
      (imp.specifier === "drizzle-orm" || imp.specifier.startsWith("drizzle-orm/")) &&
      placeOf(imp.from) !== null &&
      !imp.from.split("/").includes("infrastructure") &&
      !isTest(imp.from),
  },
];

/**
 * Crossings a layered context or featured domain still makes on its way in.
 * Each leaves the list when the port that replaces it lands.
 */
export const listedCrossings: ListedCrossing[] = [
  {
    rule: "drizzle-stays-in-infrastructure",
    from: "people/guardian-profile/guardian-profile.ts",
    to: "drizzle-orm",
    ticket: "ZHA-212",
    why: "The guardian profile renames and creates the guardian's person with its own queries, until it goes through the People repository.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/account-directory.ts",
    to: "chats/accounts/account-names.ts",
    ticket: "ZHA-214",
    why: "The phone book names each account in the directory, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/account-directory.ts",
    to: "chats/accounts/account-fold.ts",
    ticket: "ZHA-214",
    why: "The phone book folds an account's many connections into one entry, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/account-directory.ts",
    to: "chats/connected-accounts/connected-account.ts",
    ticket: "ZHA-214",
    why: "The phone book tells Rome's own accounts apart from other people's, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/account-directory.ts",
    to: "db/repositories/sentinel-log.ts",
    ticket: "ZHA-214",
    why: "The phone book lists the senders the sentinel logged as accounts, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/resource.ts",
    to: "profile-memory.ts",
    ticket: "ZHA-214",
    why: "The phone book points a person at their notes, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/resource.ts",
    to: "chats/accounts/account-names.ts",
    ticket: "ZHA-214",
    why: "The phone book names each linked account, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/resource.ts",
    to: "chats/connected-accounts/connected-account.ts",
    ticket: "ZHA-214",
    why: "The phone book tells Rome's own accounts apart from other people's, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/resource.ts",
    to: "chats/history/messages.ts",
    ticket: "ZHA-214",
    why: "The phone book dates each account by its last message, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/resource.ts",
    to: "db/index.ts",
    ticket: "ZHA-214",
    why: "The phone book reads the message history with the database handle, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/resource.ts",
    to: "db/repositories/channel-records.ts",
    ticket: "ZHA-214",
    why: "The phone book names the sender Rome speaks as on each account, until it reads that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/phone-book/application/resource.ts",
    to: "people/person-history/index.ts",
    ticket: "ZHA-213",
    why: "A person on the People page carries each account's send state and last activity, which person history reads, until the phone book gets them through the people root.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/account-messages.ts",
    to: "chats/send.ts",
    ticket: "ZHA-215",
    why: "Person history sends to a person's account, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/send.ts",
    to: "chats/connected-accounts/connected-account.ts",
    ticket: "ZHA-215",
    why: "Person history asks a connection whether it can send to an account, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/send.ts",
    to: "chats/place.ts",
    ticket: "ZHA-215",
    why: "Person history finds the chat a send goes into, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/send.ts",
    to: "chats/send.ts",
    ticket: "ZHA-215",
    why: "Person history sends to a person's account, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/send.ts",
    to: "connections/send.ts",
    ticket: "ZHA-215",
    why: "Person history picks the account Rome sends from, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/timeline-sources.ts",
    to: "chats/accounts/account-fold.ts",
    ticket: "ZHA-215",
    why: "Person history folds an account's addresses into one timeline, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/timeline-sources.ts",
    to: "chats/connected-accounts/connected-account.ts",
    ticket: "ZHA-215",
    why: "Person history reads each connection's message history, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/timeline-sources.ts",
    to: "chats/history/messages.ts",
    ticket: "ZHA-215",
    why: "Person history reads each connection's message history, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/timeline-sources.ts",
    to: "chats/history/messages-agent.ts",
    ticket: "ZHA-215",
    why: "Person history reads Rome's own transcript, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/timeline-sources.ts",
    to: "db/index.ts",
    ticket: "ZHA-215",
    why: "Person history reads Rome's own transcript with the database handle, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/person-history/application/timeline.ts",
    to: "chats/history/messages.ts",
    ticket: "ZHA-215",
    why: "Person history merges message pages into one timeline, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/link-code/application/guardian-link-code.ts",
    to: "connections/registry.ts",
    ticket: "ZHA-216",
    why: "The link code finds the connection a code arrived on, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/link-code/application/guardian-link-code.ts",
    to: "logger.ts",
    ticket: "ZHA-216",
    why: "The link code logs a redeemed code, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/link-code/application/guardian-link-code.ts",
    to: "chats/connected-accounts/admission.ts",
    ticket: "ZHA-216",
    why: "The link code holds a code back from the chat, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/link-code/application/guardian-link-code.ts",
    to: "chats/connected-accounts/connection-ports.ts",
    ticket: "ZHA-216",
    why: "The link code replies on the connection a code arrived on, until it does that through a port.",
  },
  {
    rule: "application-imports-inward",
    from: "people/link-code/application/guardian-link-code.ts",
    to: "connections/platform.ts",
    ticket: "ZHA-216",
    why: "The link code reads the platform of the connection a code arrived on, until it does that through a port.",
  },
];
