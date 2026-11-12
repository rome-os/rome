// What the Concierge follows for the guardian. What can be followed belongs to
// the connections: the connector app answers which services it connects and,
// for each one it can watch, its status, kinds and options
// (`connector_watch_sources`), subscribes at the source
// (`connector_watch_ensure`), and puts each raw event in the common shape
// (`connector_watch_normalize`). Core never names a source. It keeps the
// follows and one event-bus routine per raw event a follow listens on. Events
// are batched, triaged by the `concierge-triage` agent (triage.ts), and what
// triage kept reaches the Concierge as quiet system turns: important ones after
// each batch, and digest ones at the guardian's digest times, each in the
// Concierge chat its follow reports to (alerts.ts).

import { withoutSessionActor } from "../access/session-actor.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CONCIERGE_FOLLOW_DEFAULT_RULES,
  CONCIERGE_FOLLOW_MAX_DIGEST_TIMES,
  CONCIERGE_FOLLOW_PREFERENCE_MAX_LENGTH,
  type ConciergeChatRef,
  type ConciergeFollowChange,
  type ConciergeFollowDto,
  type ConciergeConnectorsResponse,
  type ConciergeFollowKindDto,
  type ConciergeFollowOptionDto,
  type ConciergeFollowRules,
} from "@rome/api-types/concierge";
import type { ConnectionView } from "../api/routes/connections.js";
import { actionExecutionContext } from "../apps/actions/context.js";
import type { Action } from "../apps/actions/types.js";
import type { AgentRunnerInterface } from "../core/types.js";
import type {
  ConciergeFollowItemRow,
  ConciergeFollowItemsRepository,
} from "../db/repositories/concierge-follow-items.js";
import { type RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { RoutineEngine } from "../routines/engine.js";
import { resolveGuardianTimezone } from "../instance/timezone.js";
import { createLogger } from "../logger.js";
import {
  FollowBatcher,
  ImportantDelivery,
  parseQuietHours,
  quietWindowEnd,
  guardianNow,
  renderDigestTurn,
  renderImportantTurn,
} from "./alerts.js";
import {
  agentViewOf,
  mergeConnectors,
  type ProviderService,
  type ProviderWatchSection,
} from "./connectors.js";
import { addressedToOf, cleanLabels } from "./event-shape.js";
import { optionValue, renderOptions } from "./follow-options.js";
import type { ConciergeService, DigestTaskNotes } from "./service.js";
import { type ConciergeOwner, GUARDIAN_OWNER, storedChatId } from "../webchat/owner.js";
import { MAIN_CHAT_NAME, mainChatIdOf } from "./main-chat.js";
import {
  type FollowEvent,
  MAX_EVENTS_PER_TRIAGE,
  runTriage,
  type TriageDecision,
  type TriageInput,
  type TriageRecordStore,
} from "./triage.js";

const log = createLogger("concierge-following");

/** The action each follow routine fires. */
export const CONCIERGE_FOLLOW_ACTION = "core:concierge_follow_event";
/** The action each digest routine fires. */
export const CONCIERGE_DIGEST_ACTION = "core:concierge_digest";
/** Routine keys of the digest: `concierge-digest:<HH:mm>`. */
const DIGEST_KEY_PREFIX = "concierge-digest:";
/** Delivered items are kept this long, so triage knows what was told. */
const KEEP_DELIVERED_MS = 30 * 24 * 60 * 60_000;
/** What triage reads of what was told: this far back, and at most this many lines. */
const RECENTLY_TOLD_MS = 24 * 60 * 60_000;
const RECENTLY_TOLD_MAX = 20;
/** How long after boot owed important items are delivered. */
const BOOT_DELIVERY_DELAY_MS = 60_000;
/**
 * The Concierge's own actions for what it follows. Explicit, so only an agent
 * that lists them (the Concierge) may call them. The model reaches them through
 * `execute_action`, whose allow-list is read at call time, so a running thread
 * picks them up without restarting.
 */
export const CONCIERGE_FOLLOWING_ACTIONS = {
  follow: "core:concierge_follow",
  unfollow: "core:concierge_unfollow",
  list: "core:concierge_following_list",
  configure: "core:concierge_following_configure",
} as const;
/** Routine keys of follows: `concierge-follow:<source>:<target>:<eventName>`. */
const ROUTINE_KEY_PREFIX = "concierge-follow:";
/** The guardian setting that holds the rules and the follows. */
export const CONCIERGE_FOLLOWING_SETTING_KEY = "conciergeFollowing";
/** Who claims a shared subscription, for the connector's release (rome-os/rome#1658). */
const CONSUMER = "core:concierge";
/** Sources change with connections, so their list is reused for at most this long. */
const SOURCES_TTL_MS = 30_000;

type ActionOutcome = { status: string; data?: unknown; error?: string };

type WatchTrigger = { eventName: string; filter?: { field: string; equals: string }[] };

/** The actions one app provides watch through, qualified by the app's id. */
export interface WatchProvider {
  appId: string;
  actions: { sources: string; ensure: string; normalize: string; release: string };
}

/**
 * The watch providers among the enabled apps: each app that declares
 * `watchProvider` in its manifest, with its action names qualified by its id.
 * Core never names a provider. Core runs these actions as the Concierge, so an
 * app whose four names are not all its own actions provides nothing.
 */
export function watchProvidersOf(
  apps: readonly { appId: string; manifest: { watchProvider?: WatchProvider["actions"] } }[],
  /** Who registered an action, as the action registry says. */
  ownerOf: (action: string) => { ownerType: string; ownerId: string } | undefined,
): WatchProvider[] {
  return apps.flatMap((app) => {
    const declared = app.manifest.watchProvider;
    if (!declared) return [];
    const isOwn = (name: string) => {
      const owner = ownerOf(name);
      return owner?.ownerType === "app" && owner.ownerId === app.appId;
    };
    const actions = {
      sources: `${app.appId}:${declared.sources}`,
      ensure: `${app.appId}:${declared.ensure}`,
      normalize: `${app.appId}:${declared.normalize}`,
      release: `${app.appId}:${declared.release}`,
    };
    const foreign = Object.values(actions).filter((name) => !isOwn(name));
    if (foreign.length > 0) {
      log.warn("watch provider names actions it does not have", { appId: app.appId, foreign });
      return [];
    }
    return [{ appId: app.appId, actions }];
  });
}

/**
 * What a provider's `sources` action answers: the services it connects itself,
 * and the watch section of each service it watches, with the raw events behind
 * each kind.
 */
export interface ProviderSources {
  services: ProviderService[];
  watch: ProviderWatchSectionWithTriggers[];
}

/** A provider's watch section, with the raw events behind each kind. */
export interface ProviderWatchSectionWithTriggers extends Omit<ProviderWatchSection, "kinds"> {
  kinds: (ConciergeFollowKindDto & { triggers: WatchTrigger[] })[];
}

/** A watch section, for following: its service is the follow's source. */
export interface WatchSource extends ProviderWatchSectionWithTriggers {
  source: string;
  provider: WatchProvider;
}

const kindLabelsOf = (sources: WatchSource[]) => (source: string, kind: string) =>
  sources.find((s) => s.source === source)?.kinds.find((k) => k.kind === kind)?.label ?? kind;

/** One follow, as stored. */
/** Whose a follow is: the owner it records. One from before owners were kept is the guardian's. */
const ownerOfFollow = (follow: FollowRecord): ConciergeOwner => follow.owner ?? GUARDIAN_OWNER;

interface FollowRecord {
  source: string;
  target: string;
  account: string;
  /** The kinds on. */
  kinds: string[];
  options: Record<string, unknown>;
  preference: string | null;
  /**
   * The Concierge chat its alerts go to. Null is the guardian's main chat. A
   * chat that is archived or gone sends them to the owner's main chat.
   */
  chat: string | null;
  /**
   * Whose follow it is, kept on the follow so it outlives its chat. Absent on
   * follows made before owners were kept, which are their chat's owner's.
   */
  owner?: ConciergeOwner;
}

/** A visitor's own rules, and the time zone their browser reported. */
interface PersonRules extends Partial<ConciergeFollowRules> {
  timezone?: string;
}

/** The guardian's rules are the top-level fields; each visitor's sit under `people`. */
interface StoredFollowing extends ConciergeFollowRules {
  follows: FollowRecord[];
  people?: Record<string, PersonRules>;
}

export interface ConciergeFollowingDeps {
  routines: Pick<
    RoutinesRepository,
    "create" | "findByKey" | "findById" | "listRoutines" | "deleteIfNoActiveRuns" | "update"
  >;
  routineEngine: Pick<RoutineEngine, "activate" | "deactivate">;
  actions: { register(action: Action): void };
  /** The apps that declare `watchProvider` in their manifest, read live. */
  providers(): WatchProvider[];
  /**
   * Runs an action as the Concierge. `omitFromRecord` names arguments whose
   * values the execution record leaves out, such as an event's payload.
   */
  runAction(
    name: string,
    args: Record<string, unknown>,
    options?: { omitFromRecord?: readonly string[] },
  ): Promise<ActionOutcome>;
  settings: Pick<SettingsRepository, "get" | "set">;
  /** Rome's connections and placeholders, as `GET /connections` lists them. */
  connections(): Promise<ConnectionView[]>;
  /** What triage kept, owed to the Concierge until delivered. */
  items: Pick<
    ConciergeFollowItemsRepository,
    | "add"
    | "known"
    | "owedToConcierge"
    | "owedToDigest"
    | "markOffered"
    | "markDigested"
    | "recentImportant"
    | "prune"
    | "moveToMainChat"
  >;
  /** Runs the triage agent. */
  agentRunner: AgentRunnerInterface;
  /** Where triage runs are recorded, so Sessions shows them. */
  triageRecord?: TriageRecordStore;
  now?: () => number;
  /**
   * The chat whose turn called a follow action, when a turn did. Reads the
   * action's own context unless a test gives it.
   */
  callingChat?: () => string | null;
}

/** The chat whose turn runs the current action, read from the action's context. */
function callingChatOfAction(): string | null {
  const context = actionExecutionContext.getStore()?.channelContext;
  return context?.channel === "webchat" && context.threadId ? context.threadId : null;
}

/**
 * What the Concierge's actions and the connectors route reach. Each call acts
 * for one owner: that person's follows and rules, never another's.
 */
export interface ConciergeFollowing {
  /** Every service with its state, connect entry and capabilities (watch with the owner's follows), and the owner's rules. */
  list(owner?: ConciergeOwner): Promise<ConciergeConnectorsResponse>;
  /** Follows a target, or changes a follow that exists. Throws with what the source needs. */
  follow(change: ConciergeFollowChange, owner?: ConciergeOwner): Promise<ConciergeFollowDto>;
  /** Changes a follow that exists. Null when it does not. */
  configure(
    change: ConciergeFollowChange,
    owner?: ConciergeOwner,
  ): Promise<ConciergeFollowDto | null>;
  /**
   * Stops following. The subscription at the source stays: a GitHub webhook or
   * a Gmail trigger may serve other apps too (rome-os/rome#1658).
   */
  unfollow(source: string, target: string, owner?: ConciergeOwner): Promise<{ removed: boolean }>;
  rules(owner?: ConciergeOwner): Promise<ConciergeFollowRules>;
  /** When `owner`'s quiet window `at` falls in ends, in their time zone, or null outside quiet hours. */
  quietUntil(at: number, owner: ConciergeOwner): Promise<number | null>;
  /** Changes the fields given and answers the rules as stored. */
  setRules(
    input: Partial<ConciergeFollowRules>,
    owner?: ConciergeOwner,
  ): Promise<ConciergeFollowRules>;
  /** Keeps a visitor's time zone, as their browser reports it. The guardian's is their own setting. */
  setTimezone(owner: ConciergeOwner, timezone: string): Promise<void>;
  /** Subscribes every follow again, for one whose subscription another app removed. */
  reconcile(): Promise<void>;
  /**
   * Moves the follows and owed events of Concierge chat `chatId` to its
   * owner's main chat `to` (null for the guardian's). Answers how many follows moved.
   */
  moveToMainChat(chatId: string, to?: string | null): Promise<number>;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Digest times as given, checked: 1 to 6 different `HH:mm`, sorted. Null when they do not fit. */
function parseDigestTimes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const times = [...new Set(value)];
  if (times.length === 0 || times.length > CONCIERGE_FOLLOW_MAX_DIGEST_TIMES) return null;
  if (!times.every((t): t is string => typeof t === "string" && HHMM.test(t))) return null;
  return times.sort();
}

/** The rules as stored, with the defaults for anything missing or out of bounds. */
export function parseFollowRules(value: unknown): ConciergeFollowRules {
  const stored = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    digestTimes: parseDigestTimes(stored.digestTimes) ?? CONCIERGE_FOLLOW_DEFAULT_RULES.digestTimes,
    quietHours: parseQuietHours(stored.quietHours),
  };
}

function parseFollows(value: unknown): FollowRecord[] {
  const raw = (value as { follows?: unknown } | null)?.follows;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const f = (item ?? {}) as Record<string, unknown>;
    if (typeof f.source !== "string" || typeof f.target !== "string") return [];
    return [
      {
        source: f.source,
        target: f.target,
        account: typeof f.account === "string" ? f.account : "",
        kinds: Array.isArray(f.kinds)
          ? f.kinds.filter((k): k is string => typeof k === "string")
          : [],
        options:
          f.options && typeof f.options === "object" && !Array.isArray(f.options)
            ? (f.options as Record<string, unknown>)
            : {},
        preference: typeof f.preference === "string" && f.preference ? f.preference : null,
        chat: typeof f.chat === "string" && f.chat ? f.chat : null,
        ...(typeof f.owner === "string" && f.owner ? { owner: f.owner } : {}),
      },
    ];
  });
}

/** Checks a change of the rules. Throws with what is wrong. */
export function validateRulesChange(input: Record<string, unknown>): Partial<ConciergeFollowRules> {
  const change: Partial<ConciergeFollowRules> = {};
  if (input.digestTimes !== undefined) {
    const times = parseDigestTimes(input.digestTimes);
    if (!times) {
      throw new Error(
        `digestTimes needs 1 to ${CONCIERGE_FOLLOW_MAX_DIGEST_TIMES} different HH:mm times, such as ["09:00", "18:00"]`,
      );
    }
    change.digestTimes = times;
  }
  if (input.quietHours !== undefined) {
    if (input.quietHours === null) change.quietHours = null;
    else {
      const quietHours = parseQuietHours(input.quietHours);
      if (!quietHours)
        throw new Error("quietHours needs start and end as different HH:mm times, or null");
      change.quietHours = quietHours;
    }
  }
  return change;
}

/** Checks option values against the source's options. Throws naming what fits. */
export function validateOptions(
  source: Pick<WatchSource, "source" | "options">,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const option = source.options.find((o) => o.key === key);
    if (!option) {
      const keys = source.options.map((o) => o.key).join(", ") || "none";
      throw new Error(`${source.source} has no option "${key}". Its options: ${keys}.`);
    }
    if (option.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
      out[key] = value;
    } else if (option.type === "list") {
      const items = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(",")
          : null;
      if (!items || items.some((item) => typeof item !== "string")) {
        throw new Error(`${key} must be a list of ${option.itemHint ?? "strings"}`);
      }
      out[key] = [...new Set(items.map((item) => (item as string).trim()).filter(Boolean))];
    } else {
      const values = option.values?.map((v) => v.value) ?? [];
      if (typeof value !== "string" || !values.includes(value)) {
        throw new Error(`${key} must be one of: ${values.join(", ")}`);
      }
      out[key] = value;
    }
  }
  return out;
}

/** How long after boot the follows are subscribed again, and how often after. */
const RECONCILE_DELAY_MS = 60_000;
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;

const routineKey = (source: string, target: string, eventName: string) =>
  `${ROUTINE_KEY_PREFIX}${source}:${target}:${eventName}`;

const failure = (name: string, outcome: ActionOutcome) =>
  outcome.error ?? `${name} returned ${outcome.status}`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** An event as its connection put it in the common shape. */
type NormalizedEvent = Omit<FollowEvent, "target" | "account" | "at"> & Record<string, unknown>;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

/** Starts delivery of followed events and registers the follow actions. Returns the stop. */
export function startConciergeFollowing(
  service: ConciergeService,
  deps: ConciergeFollowingDeps,
): () => void {
  const now = deps.now ?? (() => Date.now());
  const callingChat = deps.callingChat ?? callingChatOfAction;
  // The actions run in main, inside their execution's async context, which may
  // not call other actions. The connector's watch actions, and the queue's
  // timer that starts a Concierge turn, run in the context of boot instead.
  const outsideAction = AsyncLocalStorage.snapshot();
  const run = (
    provider: WatchProvider,
    action: keyof WatchProvider["actions"],
    args: Record<string, unknown>,
    options?: { omitFromRecord?: readonly string[] },
  ) => outsideAction(() => deps.runAction(provider.actions[action], args, options));

  const readStored = async (): Promise<StoredFollowing> => {
    const value = await deps.settings.get(CONCIERGE_FOLLOWING_SETTING_KEY);
    const people = (value as { people?: unknown } | null)?.people;
    return {
      ...parseFollowRules(value),
      follows: parseFollows(value),
      ...(people && typeof people === "object"
        ? { people: people as Record<string, PersonRules> }
        : {}),
    };
  };
  const writeStored = async (next: StoredFollowing) => {
    await deps.settings.set(CONCIERGE_FOLLOWING_SETTING_KEY, next);
  };

  /** An owner's rules: the guardian's top-level ones, a visitor's own with the defaults. */
  const rulesOf = (stored: StoredFollowing, owner: ConciergeOwner): ConciergeFollowRules =>
    owner === GUARDIAN_OWNER
      ? parseFollowRules(stored)
      : parseFollowRules(stored.people?.[owner] ?? {});

  /** Where an owner is: the guardian's time zone setting, a visitor's reported zone, else the guardian's. */
  const timezoneOf = async (owner: ConciergeOwner, stored?: StoredFollowing): Promise<string> => {
    if (owner !== GUARDIAN_OWNER) {
      const zone = (stored ?? (await readStored())).people?.[owner]?.timezone;
      if (zone) return zone;
    }
    return resolveGuardianTimezone(deps.settings);
  };

  /** The follows of one owner. */
  const followsOf = (stored: StoredFollowing, owner: ConciergeOwner) =>
    stored.follows.filter((follow) => ownerOfFollow(follow) === owner);

  /**
   * The owner of the chat whose turn called a follow action; the guardian for
   * any other caller. A chat that is gone has no owner to act for.
   */
  const callingOwner = async (): Promise<ConciergeOwner> => {
    const calling = callingChat();
    if (!calling) return GUARDIAN_OWNER;
    const owner = await service.ownerOfChat(calling);
    if (owner === null) throw new Error(`No Concierge chat ${calling}`);
    return owner;
  };

  let sourcesCache: {
    at: number;
    services: ProviderService[];
    watch: WatchSource[];
  } | null = null;
  /** Every provider's services and watch sections, the first provider winning a shared service. */
  const readProviders = async (fresh = false) => {
    if (!fresh && sourcesCache && now() - sourcesCache.at < SOURCES_TTL_MS) return sourcesCache;
    const services: ProviderService[] = [];
    const watch: WatchSource[] = [];
    for (const provider of deps.providers()) {
      const outcome = await run(provider, "sources", {}).catch((error: unknown) => ({
        status: "error",
        error: messageOf(error),
      }));
      if (outcome.status !== "ok") {
        log.warn("watch provider unavailable", {
          appId: provider.appId,
          error: (outcome as ActionOutcome).error,
        });
        continue;
      }
      const data = ((outcome as ActionOutcome).data ?? {}) as Partial<ProviderSources>;
      for (const service of Array.isArray(data.services) ? data.services : []) {
        if (!services.some((s) => s.service === service.service)) services.push(service);
      }
      for (const section of Array.isArray(data.watch) ? data.watch : []) {
        if (watch.some((s) => s.source === section.service)) continue;
        watch.push({ ...section, source: section.service, provider });
      }
    }
    sourcesCache = { at: now(), services, watch };
    return sourcesCache;
  };
  const readSources = async (fresh = false): Promise<WatchSource[]> =>
    (await readProviders(fresh)).watch;
  const sourceOf = async (name: string, fresh = false) => {
    const sources = await readSources(fresh);
    const found = sources.find((s) => s.source === name);
    if (!found) {
      const names = sources.map((s) => s.source).join(", ") || "none";
      throw new Error(
        `Rome cannot follow "${name}". Sources that can be followed: ${names}. ${CONCIERGE_FOLLOWING_ACTIONS.list} says what each one needs.`,
      );
    }
    return found;
  };

  const quietUntil = async (at: number, owner: ConciergeOwner) => {
    const stored = await readStored();
    const { quietHours } = rulesOf(stored, owner);
    if (!quietHours) return null;
    return quietWindowEnd(at, quietHours, await timezoneOf(owner, stored));
  };

  /** A Concierge chat as a list shows it; one that is gone or archived reads as its owner's main chat. */
  const chatRefOf = async (
    chatId: string | null,
    owner: ConciergeOwner,
  ): Promise<ConciergeChatRef> => {
    const live = chatId ? await service.conciergeChat(chatId) : null;
    if (live) return live;
    const main = mainChatIdOf(owner);
    return (await service.conciergeChat(main)) ?? { id: main, name: MAIN_CHAT_NAME, main: true };
  };

  /**
   * The stored form of a chat a change names, which must be one of `owner`'s
   * Concierge chats: null for the guardian's main chat. Throws for any other chat.
   */
  const storedChatOf = async (chatId: string, owner: ConciergeOwner): Promise<string | null> => {
    const chat = await service.conciergeChat(chatId);
    if (!chat || (await service.ownerOfChat(chatId)) !== owner) {
      throw new Error(`No Concierge chat ${chatId}. Name one the following list shows.`);
    }
    return storedChatId(chat.id);
  };

  /** The chat a new follow reports to: the one asked for, else the chat that asked, else the owner's main chat. */
  const chatForNewFollow = async (
    asked: string | undefined,
    owner: ConciergeOwner,
  ): Promise<string | null> => {
    if (asked) return storedChatOf(asked, owner);
    const calling = callingChat();
    const chat = calling ? await service.conciergeChat(calling) : null;
    if (chat && (await service.ownerOfChat(chat.id)) === owner) return storedChatId(chat.id);
    return storedChatId(mainChatIdOf(owner));
  };

  const delivery = new ImportantDelivery({
    now,
    isServed: (owner) => service.isServed(owner),
    quietUntil,
    owed: () => deps.items.owedToConcierge(),
    // One turn per Concierge chat, each counted against the hourly cap.
    groupOf: (item) => item.chatId ?? "",
    // Past the hourly cap the Concierge does not get them now; the digest still does.
    skip: (items) =>
      deps.items.markOffered(
        items.map((item) => item.id),
        new Date(now()),
      ),
    send: async (items, held) => {
      // A chat that is gone or archived hands its items to their owner's main chat.
      const owner = items[0]?.ownerKey ?? GUARDIAN_OWNER;
      const chatId = await service.deliveryChat(items[0]?.chatId, owner);
      // The Concierge decides whether to tell each item now. Either way every
      // item also goes into the next digest.
      // Its input stays in the run's trace, so Sessions shows why it said what it said.
      const at = guardianNow(now(), await timezoneOf(items[0]?.ownerKey ?? GUARDIAN_OWNER));
      const kindLabel = kindLabelsOf(await readSources().catch(() => [] as WatchSource[]));
      const ran =
        chatId !== null &&
        (await service.runSystemTurn(chatId, renderImportantTurn(items, held, at, kindLabel), {
          quiet: true,
          inputLabel: `Following · important (${items.length})`,
          pushLevel: "active",
        }));
      // Items the Concierge never had stay owed, and the delivery tries again.
      if (!ran) throw new Error("the Concierge's important turn did not run to its end");
      await deps.items.markOffered(
        items.map((item) => item.id),
        new Date(now()),
      );
      log.info("following important", { items: items.length, held, delivered: true });
    },
  });

  /**
   * Triage of one batch: every event gets important, digest or ignore, and the
   * kept ones are stored. Each owner's events are triaged apart, with that
   * person's follows, what they were told and their time zone.
   */
  const triageBatch = async (events: FollowEvent[]) => {
    const byOwner = new Map<ConciergeOwner, FollowEvent[]>();
    for (const event of events) {
      const owner = event.owner ?? GUARDIAN_OWNER;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), event]);
    }
    for (const [owner, ownerEvents] of byOwner) {
      // A visitor dropped from the dashboard allow-list keeps their follows,
      // but their events are not triaged or kept until they are back.
      if (!(await service.isServed(owner))) {
        log.info("following skipped an owner no longer served", { events: ownerEvents.length });
        continue;
      }
      await triageFor(owner, ownerEvents);
    }
    await delivery.deliver();
  };

  const triageFor = async (owner: ConciergeOwner, events: FollowEvent[]) => {
    const known = await deps.items.known(
      events.map((e) => e.id),
      owner,
    );
    const fresh = events.filter((e) => !known.has(e.id));
    if (fresh.length === 0) return;
    const stored = await readStored();
    const follows = followsOf(stored, owner);
    const told = await deps.items.recentImportant(
      new Date(now() - RECENTLY_TOLD_MS),
      RECENTLY_TOLD_MAX,
      owner,
    );
    const timezone = await timezoneOf(owner, stored);
    const decisions: TriageDecision[] = [];
    const sources = await readSources().catch(() => [] as WatchSource[]);
    const kindLabel = kindLabelsOf(sources);
    for (const part of chunks(fresh, MAX_EVENTS_PER_TRIAGE)) {
      const inPart = new Set(part.map((e) => `${e.source}:${e.target}`));
      const input: TriageInput = {
        // Triage judges the event, never whose follow it came through.
        events: part.map(({ owner: _owner, ...event }) => ({
          ...event,
          kind: kindLabel(event.source, event.kind),
        })),
        accounts: [...new Map(part.map((e) => [e.source, e.account])).entries()].map(
          ([source, account]) => ({ source, account }),
        ),
        follows: follows
          .filter((f) => inPart.has(`${f.source}:${f.target}`))
          .map(({ source, target, kinds, options, preference }) => ({
            source,
            target,
            kinds: kinds.map((kind) => kindLabel(source, kind)),
            // The guardian's wishes in words, from the catalog's declarations.
            options: renderOptions(
              sources.find((s) => s.source === source)?.options ?? [],
              options,
            ),
            preference,
          })),
        recentlyTold: told.map((item) => ({
          source: item.source,
          target: item.target,
          line: item.line,
          at: item.createdAt.toISOString(),
        })),
        now: guardianNow(now(), timezone),
      };
      const result = await runTriage(deps.agentRunner, input, { record: deps.triageRecord });
      if (result.error)
        log.warn("triage failed; its events go to the digest", {
          events: part.length,
          error: result.error,
        });
      decisions.push(...result.decisions);
    }
    const byId = new Map(fresh.map((e) => [e.id, e]));
    const chatOfFollow = new Map(follows.map((f) => [`${f.source}\u0000${f.target}`, f.chat]));
    const kept = [];
    for (const decision of decisions) {
      const event = byId.get(decision.id);
      if (!event) continue;
      if (decision.decision === "ignore") {
        log.info("follow event ignored", {
          source: event.source,
          kind: event.kind,
          reason: decision.reason,
        });
        continue;
      }
      kept.push({
        eventId: event.id,
        source: event.source,
        kind: event.kind,
        target: event.target,
        decision: decision.decision,
        reason: decision.reason,
        line: decision.line,
        url: event.url ?? null,
        // An event queued before its follow went reports to its owner's main
        // chat, never to another owner's.
        chatId: chatOfFollow.has(`${event.source}\u0000${event.target}`)
          ? (chatOfFollow.get(`${event.source}\u0000${event.target}`) ?? null)
          : storedChatId(mainChatIdOf(owner)),
        ownerKey: owner,
      });
    }
    const added = await deps.items.add(kept, new Date(now()));
    log.info("follow batch triaged", {
      events: fresh.length,
      important: added.filter((i) => i.decision === "important").length,
      digest: added.filter((i) => i.decision === "digest").length,
      ignored: fresh.length - kept.length,
    });
  };

  const batcher = new FollowBatcher({
    now,
    flush: (events) => outsideAction(() => triageBatch(events)),
  });

  /**
   * Hands an owner's owed digest to the Concierge as one turn in each chat that
   * has items or task notes, and an empty one in the main chat when nothing is
   * owed at all. A chat's items and notes are marked once its own turn ran to
   * its end, so one chat's failure leaves only its own owed.
   */
  const deliverDigest = async (owner: ConciergeOwner): Promise<{ items: number }> => {
    if (!(await service.isServed(owner))) return { items: 0 };
    const owed = await deps.items.owedToDigest(owner);
    const at = guardianNow(now(), await timezoneOf(owner));
    const kindLabel = kindLabelsOf(await readSources().catch(() => [] as WatchSource[]));
    // A chat that is gone or archived hands its items to the main chat.
    const resolved = new Map<string, string | null>();
    const perChat = new Map<string | null, ConciergeFollowItemRow[]>();
    for (const item of owed) {
      const key = item.chatId ?? "";
      if (!resolved.has(key)) resolved.set(key, await service.deliveryChat(item.chatId, owner));
      const chatId = resolved.get(key) ?? null;
      perChat.set(chatId, [...(perChat.get(chatId) ?? []), item]);
    }
    // A chat's digest also says which of its tasks to bring up again, and a
    // chat with such notes gets one even with no items. An archived chat's
    // tasks read as the main chat's, so their notes go there.
    const notes = new Map<string, DigestTaskNotes>();
    const chats = await service.listChats(owner).catch((error: unknown) => {
      log.warn("digest could not list the chats", { error: messageOf(error) });
      return [];
    });
    const chatIds = new Set([
      ...chats.map((chat) => chat.id),
      ...[...perChat.keys()].filter((id): id is string => id !== null),
    ]);
    for (const chatId of chatIds) {
      const read = await Promise.resolve()
        .then(() => service.digestTaskNotes(chatId, owner))
        .catch((error: unknown) => {
          log.warn("digest task notes failed", { chatId, error: messageOf(error) });
          return null;
        });
      if (!read?.text) continue;
      notes.set(chatId, read);
      if (!perChat.has(chatId)) perChat.set(chatId, []);
    }
    // An empty digest still runs, with count="0", so the person hears that
    // nothing new came in anywhere: no item and no task note in any chat.
    if (perChat.size === 0) perChat.set(await service.findChatId(owner), []);
    let delivered = 0;
    let turns = 0;
    for (const [chatId, items] of perChat) {
      let ok = false;
      const note = chatId === null ? undefined : notes.get(chatId);
      const turn = renderDigestTurn(items, at, kindLabel);
      const prompt = note ? `${turn}\n${note.text}` : turn;
      try {
        ok =
          chatId !== null &&
          (await outsideAction(() =>
            service.runSystemTurn(chatId, prompt, {
              quiet: true,
              inputLabel: `Following · digest (${items.length})`,
              // A digest is expected at its time, so it arrives without an alert.
              pushLevel: "passive",
            }),
          ));
      } catch (error) {
        log.warn("digest turn threw; its items stay owed", { chatId, error: messageOf(error) });
      }
      log.info("following digest", { chatId, items: items.length, delivered: ok });
      // A digest that did not run to its end leaves its items and notes for the next one.
      if (!ok) continue;
      await deps.items.markDigested(
        items.map((item) => item.id),
        new Date(now()),
      );
      if (note) {
        await service.markTaskNotesListed(note).catch((error: unknown) => {
          log.warn("failed to mark digest task notes listed", { chatId, error: messageOf(error) });
        });
      }
      delivered += items.length;
      turns++;
    }
    if (turns > 0) await deps.items.prune(new Date(now() - KEEP_DELIVERED_MS));
    return { items: delivered };
  };

  /** Follow routines made before they kept no payload stop keeping it. */
  const keepNoPayloads = async () => {
    for (const routine of await deps.routines.listRoutines()) {
      if (!routine.key?.startsWith(ROUTINE_KEY_PREFIX) || routine.keepTriggerPayload === false) {
        continue;
      }
      await deps.routines.update(routine.id, { keepTriggerPayload: false });
      if (routine.enabled) await reactivate(routine.id);
    }
  };

  /**
   * One digest routine per digest time of each person who follows anything,
   * in their own time zone; none for anyone else. The guardian's keep their
   * keys (`concierge-digest:<time>`); a visitor's name their main chat.
   */
  const syncDigestRoutines = async () => {
    const stored = await readStored();
    const owners = [...new Set(stored.follows.map(ownerOfFollow))];
    const wanted = new Map<string, { owner: ConciergeOwner; localTime: string }>();
    for (const owner of owners) {
      for (const localTime of rulesOf(stored, owner).digestTimes) {
        const key =
          owner === GUARDIAN_OWNER
            ? `${DIGEST_KEY_PREFIX}${localTime}`
            : `${DIGEST_KEY_PREFIX}${mainChatIdOf(owner)}:${localTime}`;
        wanted.set(key, { owner, localTime });
      }
    }
    for (const routine of await deps.routines.listRoutines()) {
      if (!routine.key?.startsWith(DIGEST_KEY_PREFIX)) continue;
      if (!wanted.has(routine.key)) await removeRoutine(routine.id);
    }
    for (const [key, { owner, localTime }] of wanted) {
      // The guardian's digest floats with the guardian's zone, as every
      // floating routine does. A visitor's is fixed to their own zone, and
      // rebuilt here whenever it changes.
      const trigger = {
        type: "schedule" as const,
        tzid: await timezoneOf(owner, stored),
        tzMode: owner === GUARDIAN_OWNER ? ("floating" as const) : ("fixed" as const),
        localTime,
        rrule: "FREQ=DAILY",
      };
      const args = owner === GUARDIAN_OWNER ? {} : { owner };
      const existing = await deps.routines.findByKey(key);
      const id = existing
        ? existing.id
        : await deps.routines.create({
            name: `Digest at ${localTime}`,
            key,
            trigger,
            actionName: CONCIERGE_DIGEST_ACTION,
            args,
            // It acts for the person whose Concierge it serves, whoever's
            // request set the digest times.
            createdBy: { owner },
          });
      if (existing) await deps.routines.update(id, { trigger, args, enabled: true });
      await reactivate(id);
    }
  };
  const syncDigest = () =>
    syncDigestRoutines().catch((error: unknown) =>
      log.warn("digest routines not synced", { error: messageOf(error) }),
    );

  const reactivate = async (id: string) => {
    await deps.routineEngine.deactivate(id);
    const row = await deps.routines.findById(id);
    if (row?.enabled) await deps.routineEngine.activate(toRoutine(row));
  };

  const removeRoutine = async (id: string) => {
    const result = await deps.routines.deleteIfNoActiveRuns(id);
    if (result.status === "active-runs") {
      // A run is in flight; turn it off now, so it is gone for every later event.
      await deps.routines.update(id, { enabled: false });
    }
    await deps.routineEngine.deactivate(id);
  };

  /**
   * Makes a target's routines match the kinds its follows have on: one per raw
   * event any of them listens on. Two people following one target share its
   * routines, and the event action hands each event to each follow.
   */
  const syncRoutines = async (
    source: WatchSource,
    follow: Pick<FollowRecord, "source" | "target">,
    follows: FollowRecord[],
  ) => {
    const kindsOn = new Set(follows.flatMap((f) => f.kinds));
    const wanted = new Map<string, WatchTrigger>();
    for (const kind of source.kinds) {
      if (!kindsOn.has(kind.kind)) continue;
      for (const trigger of kind.triggers) {
        const filter = trigger.filter?.map((c) => ({
          field: c.field,
          equals: c.equals.replaceAll("{target}", follow.target),
        }));
        wanted.set(trigger.eventName, {
          eventName: trigger.eventName,
          ...(filter ? { filter } : {}),
        });
      }
    }
    const prefix = `${ROUTINE_KEY_PREFIX}${follow.source}:${follow.target}:`;
    for (const routine of await deps.routines.listRoutines()) {
      if (!routine.key?.startsWith(prefix)) continue;
      if (!wanted.has(routine.key.slice(prefix.length))) await removeRoutine(routine.id);
    }
    for (const trigger of wanted.values()) {
      const key = routineKey(follow.source, follow.target, trigger.eventName);
      const args = { source: follow.source, target: follow.target, eventName: trigger.eventName };
      const routineTrigger = { type: "event-bus" as const, ...trigger };
      const existing = await deps.routines.findByKey(key);
      let id: string;
      if (existing) {
        id = existing.id;
        await deps.routines.update(id, {
          args,
          trigger: routineTrigger,
          enabled: true,
          keepTriggerPayload: false,
        });
      } else {
        // An event's payload (a whole mail, say) stays out of the run history.
        id = await deps.routines.create({
          name: `Follow ${follow.target} (${source.label})`,
          key,
          trigger: routineTrigger,
          actionName: CONCIERGE_FOLLOW_ACTION,
          args,
          keepTriggerPayload: false,
          // One watcher serves every owner who follows this target, so it
          // acts for no one person. What it finds goes to each owner's own
          // Concierge chat, which is private to them.
          createdBy: { kind: "anonymous" },
        });
      }
      await reactivate(id);
    }
  };

  const toDto = (
    source: WatchSource,
    follow: FollowRecord,
    chat: ConciergeChatRef,
  ): ConciergeFollowDto => {
    const options: Record<string, string | boolean | string[]> = {};
    for (const option of source.options) {
      options[option.key] = optionValue(option, follow.options[option.key]);
    }
    const kinds = source.kinds.map((k) => ({ kind: k.kind, on: follow.kinds.includes(k.kind) }));
    // A kind on whose subscription at the source is missing gets no events, whatever the source's status.
    const undelivered = source.kinds.filter(
      (k) => follow.kinds.includes(k.kind) && source.undelivered?.kinds.includes(k.kind),
    );
    const ready = source.status === "ready" && undelivered.length === 0;
    return {
      target: follow.target,
      state: !ready ? "unavailable" : kinds.some((k) => k.on) ? "active" : "off",
      ...(source.status === "ready" && undelivered.length > 0 && source.undelivered
        ? {
            reason: `${undelivered.map((k) => k.label).join(", ")}: ${source.undelivered.reason}`,
          }
        : {}),
      kinds,
      options,
      preference: follow.preference,
      chat,
    };
  };

  /** The source as it is once these kinds were just subscribed: none of them is undelivered. */
  const withArmed = (source: WatchSource, kinds: string[]): WatchSource =>
    source.undelivered
      ? {
          ...source,
          undelivered: {
            ...source.undelivered,
            kinds: source.undelivered.kinds.filter((k) => !kinds.includes(k)),
          },
        }
      : source;

  /** Applies a change to a follow record, checked against its source. */
  const applyChange = (
    source: WatchSource,
    follow: FollowRecord,
    change: ConciergeFollowChange,
  ): FollowRecord => {
    const next: FollowRecord = {
      ...follow,
      kinds: [...follow.kinds],
      options: { ...follow.options },
    };
    if (change.options) Object.assign(next.options, validateOptions(source, change.options));
    // An option that a kind requires turns the kind on with it, unless the change says otherwise.
    for (const kind of source.kinds) {
      const requires = kind.requires;
      if (!requires || change.options?.[requires.option] !== requires.value) continue;
      if (change.kinds?.[kind.kind] === undefined && !next.kinds.includes(kind.kind)) {
        next.kinds.push(kind.kind);
      }
    }
    if (change.kinds) {
      for (const [kind, on] of Object.entries(change.kinds)) {
        if (!source.kinds.some((k) => k.kind === kind)) {
          const kinds = source.kinds.map((k) => k.kind).join(", ");
          throw new Error(`${source.source} has no kind "${kind}". Its kinds: ${kinds}.`);
        }
        if (typeof on !== "boolean") throw new Error(`kinds.${kind} must be true or false`);
        next.kinds = on
          ? [...new Set([...next.kinds, kind])]
          : next.kinds.filter((k) => k !== kind);
      }
    }
    if (change.preference !== undefined) {
      const preference = change.preference?.trim() ?? "";
      if (preference.length > CONCIERGE_FOLLOW_PREFERENCE_MAX_LENGTH) {
        throw new Error(
          `preference must be at most ${CONCIERGE_FOLLOW_PREFERENCE_MAX_LENGTH} characters`,
        );
      }
      next.preference = preference || null;
    }
    // A kind that needs an option value the follow does not have is off.
    next.kinds = next.kinds.filter((kind) => {
      const requires = source.kinds.find((k) => k.kind === kind)?.requires;
      if (!requires) return true;
      const option = source.options.find((o) => o.key === requires.option);
      return option ? optionValue(option, next.options[requires.option]) === requires.value : false;
    });
    return next;
  };

  const ensure = async (provider: WatchProvider, follow: FollowRecord, dryRun: boolean) => {
    if (follow.kinds.length === 0) return;
    const outcome = await run(provider, "ensure", {
      source: follow.source,
      target: follow.target,
      kinds: follow.kinds,
      dryRun,
    });
    if (outcome.status !== "ok") throw new Error(failure(provider.actions.ensure, outcome));
  };

  // Every change reads the whole setting and writes it back, so two at once
  // (two execute_action calls, chat and the API) would lose one. They take turns.
  let writes: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writes.then(task);
    writes = next.catch(() => undefined);
    return next;
  };

  /** The other owners' follows of one target, which share its routines. */
  const othersOn = (
    stored: StoredFollowing,
    source: string,
    target: string,
    owner: ConciergeOwner,
  ) =>
    stored.follows.filter(
      (f) => f.source === source && f.target === target && ownerOfFollow(f) !== owner,
    );

  /** An owner's follow of one target, or undefined. */
  const findFollow = (
    stored: StoredFollowing,
    owner: ConciergeOwner,
    matches: (follow: FollowRecord) => boolean,
  ) => followsOf(stored, owner).find(matches);

  const unserialized: ConciergeFollowing = {
    async list(owner = GUARDIAN_OWNER) {
      const [{ services, watch }, stored, connections] = await Promise.all([
        readProviders(true),
        readStored(),
        deps.connections(),
      ]);
      const mine = followsOf(stored, owner);
      const chats = new Map<string, ConciergeChatRef>();
      for (const follow of mine) {
        const key = follow.chat ?? "";
        if (!chats.has(key)) chats.set(key, await chatRefOf(follow.chat, owner));
      }
      return {
        connectors: mergeConnectors({
          connections,
          services,
          watch: watch.map(({ provider: _provider, source: _source, ...section }) => ({
            ...section,
            kinds: section.kinds.map(({ triggers: _triggers, ...kind }) => kind),
          })),
          followsOf: (service) => {
            const source = watch.find((s) => s.source === service);
            return source
              ? mine
                  .filter((f) => f.source === service)
                  .map((f) => toDto(source, f, chats.get(f.chat ?? "") as ConciergeChatRef))
              : [];
          },
        }),
        rules: rulesOf(stored, owner),
      };
    },

    async follow(change, owner = GUARDIAN_OWNER) {
      const source = await sourceOf(change.source, true);
      if (source.status !== "ready") {
        throw new Error(
          `${source.label} cannot be followed now: ${source.statusReason ?? source.status}`,
        );
      }
      const account = source.account ?? "";
      let target = change.target?.trim() ?? "";
      if (source.target) {
        if (!target) {
          throw new Error(
            `${source.label} needs a target: ${source.target.format}, for example ${source.target.example}.`,
          );
        }
      } else {
        // The connected account itself; naming another one is a mistake to say out loud.
        if (target && target.toLowerCase() !== account.toLowerCase()) {
          throw new Error(
            `${source.label} follows the account connected to Rome, ${account}, not ${target}. Leave target out.`,
          );
        }
        target = account;
      }
      const stored = await readStored();
      const existing = findFollow(
        stored,
        owner,
        (f) => f.source === source.source && f.target === target,
      );
      const base: FollowRecord = existing ?? {
        source: source.source,
        target,
        account,
        kinds: source.kinds.filter((k) => k.default).map((k) => k.kind),
        options: {},
        preference: null,
        chat: await chatForNewFollow(change.chatId, owner),
        owner,
      };
      const next = {
        ...applyChange(source, base, change),
        account,
        owner,
        // One that exists moves only when the change names a chat.
        ...(existing && change.chatId ? { chat: await storedChatOf(change.chatId, owner) } : {}),
      };
      // Check first, so a refusal (no admin rights for a webhook) leaves nothing behind.
      await ensure(source.provider, next, true);
      await ensure(source.provider, next, false);
      await syncRoutines(source, next, [...othersOn(stored, source.source, target, owner), next]);
      await writeStored({
        ...stored,
        follows: [...stored.follows.filter((f) => f !== existing), next],
      });
      if (!existing) await syncDigest();
      return toDto(withArmed(source, next.kinds), next, await chatRefOf(next.chat, owner));
    },

    async configure(change, owner = GUARDIAN_OWNER) {
      const source = await sourceOf(change.source);
      const stored = await readStored();
      const target = change.target?.trim() || (source.target ? "" : (source.account ?? ""));
      const existing = findFollow(
        stored,
        owner,
        (f) => f.source === source.source && f.target === target,
      );
      if (!existing) return null;
      const next = {
        ...applyChange(source, existing, change),
        owner,
        ...(change.chatId ? { chat: await storedChatOf(change.chatId, owner) } : {}),
      };
      const added = next.kinds.filter((k) => !existing.kinds.includes(k));
      if (added.length > 0 && source.status === "ready") {
        await ensure(source.provider, { ...next, kinds: added }, false);
      }
      await syncRoutines(source, next, [...othersOn(stored, source.source, target, owner), next]);
      await writeStored({
        ...stored,
        follows: stored.follows.map((f) => (f === existing ? next : f)),
      });
      return toDto(
        withArmed(source, source.status === "ready" ? added : []),
        next,
        await chatRefOf(next.chat, owner),
      );
    },

    async unfollow(sourceName, rawTarget, owner = GUARDIAN_OWNER) {
      const stored = await readStored();
      const target = rawTarget.trim();
      const existing = findFollow(
        stored,
        owner,
        (f) =>
          f.source === sourceName && (f.target === target || (!target && f.target === f.account)),
      );
      const followed = existing?.target ?? target;
      // Another person's follow of the same target keeps the routines it needs.
      const others = othersOn(stored, sourceName, followed, owner);
      let removed = false;
      if (others.length > 0) {
        const source = (await readSources().catch(() => [])).find((s) => s.source === sourceName);
        if (source) await syncRoutines(source, { source: sourceName, target: followed }, others);
      } else {
        const prefix = `${ROUTINE_KEY_PREFIX}${sourceName}:${followed}:`;
        for (const routine of await deps.routines.listRoutines()) {
          if (!routine.key?.startsWith(prefix)) continue;
          await removeRoutine(routine.id);
          removed = true;
        }
      }
      if (existing) {
        await writeStored({ ...stored, follows: stored.follows.filter((f) => f !== existing) });
        removed = true;
        await syncDigest();
        // Nothing is released yet; the connector answers so (rome-os/rome#1658).
        const provider = (await readSources().catch(() => [])).find(
          (s) => s.source === existing.source,
        )?.provider;
        if (provider && others.length === 0) {
          await run(provider, "release", {
            source: existing.source,
            target: existing.target,
            consumer: CONSUMER,
          }).catch(() => undefined);
        }
      }
      return { removed };
    },

    rules: async (owner = GUARDIAN_OWNER) => rulesOf(await readStored(), owner),

    quietUntil,

    async setRules(change, owner = GUARDIAN_OWNER) {
      const stored = await readStored();
      const next = parseFollowRules({ ...rulesOf(stored, owner), ...change });
      await writeStored(
        owner === GUARDIAN_OWNER
          ? { ...stored, ...next }
          : {
              ...stored,
              people: { ...stored.people, [owner]: { ...stored.people?.[owner], ...next } },
            },
      );
      if (change.digestTimes) await syncDigest();
      // A quiet window that ended or went away frees what it held.
      if (change.quietHours !== undefined) void outsideAction(() => delivery.deliver());
      return next;
    },

    async setTimezone(owner, timezone) {
      if (owner === GUARDIAN_OWNER) return;
      const stored = await readStored();
      if (stored.people?.[owner]?.timezone === timezone) return;
      await writeStored({
        ...stored,
        people: { ...stored.people, [owner]: { ...stored.people?.[owner], timezone } },
      });
      // A visitor's digest runs at their own local times.
      await syncDigest();
    },

    async moveToMainChat(chatId, to = null) {
      const stored = await readStored();
      const moved = stored.follows.filter((f) => f.chat === chatId).length;
      if (moved > 0) {
        await writeStored({
          ...stored,
          follows: stored.follows.map((f) => (f.chat === chatId ? { ...f, chat: to } : f)),
        });
      }
      await deps.items.moveToMainChat(chatId, to);
      return moved;
    },

    async reconcile() {
      await syncDigest();
      await keepNoPayloads();
      const { follows } = await readStored();
      if (follows.length === 0) return;
      const sources = await readSources(true);
      for (const follow of follows) {
        const source = sources.find((s) => s.source === follow.source);
        if (source?.status !== "ready") continue;
        await ensure(source.provider, follow, false).catch((error: unknown) =>
          log.warn("follow subscription not restored", {
            source: follow.source,
            target: follow.target,
            error: messageOf(error),
          }),
        );
      }
    },
  };
  const following: ConciergeFollowing = {
    ...unserialized,
    follow: (change, owner) => exclusive(() => unserialized.follow(change, owner)),
    configure: (change, owner) => exclusive(() => unserialized.configure(change, owner)),
    unfollow: (source, target, owner) =>
      exclusive(() => unserialized.unfollow(source, target, owner)),
    setRules: (change, owner) => exclusive(() => unserialized.setRules(change, owner)),
    setTimezone: (owner, timezone) => exclusive(() => unserialized.setTimezone(owner, timezone)),
    moveToMainChat: (chatId, to) => exclusive(() => unserialized.moveToMainChat(chatId, to)),
  };
  service.attachFollowing(following);

  deps.actions.register({
    config: followingActionConfig(
      CONCIERGE_FOLLOW_ACTION,
      "Internal: hands an event from something the Concierge follows to its queue. Fired by its follow routines; not agent-callable.",
      "write",
    ),
    execute: async (args) => {
      const payload = args.__triggerPayload;
      const { source, target, eventName } = args as Record<string, unknown>;
      if (
        typeof source !== "string" ||
        typeof target !== "string" ||
        typeof eventName !== "string" ||
        !payload ||
        typeof payload !== "object"
      ) {
        return {
          status: "error",
          error: "concierge_follow_event needs source, target, eventName and an event payload",
        };
      }
      // Each person who follows the target hears it once, through their own follow.
      const follows = (await readStored()).follows.filter(
        (f) => f.source === source && f.target === target,
      );
      if (follows.length === 0) return { status: "ok", data: { ignored: "not followed" } };
      const provider = (await readSources()).find((s) => s.source === source)?.provider;
      if (!provider) return { status: "ok", data: { ignored: "no provider watches it now" } };
      const results: Record<string, string>[] = [];
      for (const follow of follows) {
        const owner = ownerOfFollow(follow);
        // The event itself (a whole mail, say) stays out of the execution record.
        const outcome = await run(
          provider,
          "normalize",
          { source, eventName, payload, account: follow.account, kinds: follow.kinds },
          { omitFromRecord: ["payload"] },
        );
        if (outcome.status !== "ok") {
          return { status: "error", error: failure(provider.actions.normalize, outcome) };
        }
        const normalized = outcome.data as
          | { keep: false; reason: string }
          | { keep: true; event: NormalizedEvent }
          | undefined;
        if (!normalized?.keep) {
          results.push({ ignored: normalized?.reason ?? "dropped" });
          continue;
        }
        const raw = normalized.event;
        const event: FollowEvent = {
          id: String(raw.id),
          source: follow.source,
          kind: String(raw.kind),
          target: follow.target,
          account: follow.account,
          ...(typeof raw.actor === "string" ? { actor: raw.actor } : {}),
          ...(typeof raw.subject === "string" ? { subject: raw.subject } : {}),
          ...(typeof raw.url === "string" ? { url: raw.url } : {}),
          ...(typeof raw.excerpt === "string" ? { excerpt: raw.excerpt } : {}),
          byYou: raw.byYou === true,
          addressedTo: addressedToOf(raw.addressedTo),
          labels: cleanLabels(raw.labels),
          at: now(),
          owner,
        };
        const queued = outsideAction(() => batcher.add(event));
        results.push(queued ? { queued: event.kind } : { ignored: "already queued" });
      }
      return { status: "ok", data: results.length === 1 ? results[0] : { results } };
    },
  });
  deps.actions.register({
    config: followingActionConfig(
      CONCIERGE_DIGEST_ACTION,
      "Internal: hands the owed digest of followed events to the Concierge. Fired by its digest routines; not agent-callable.",
      "write",
    ),
    execute: async (args) => {
      try {
        const owner = typeof args.owner === "string" ? args.owner : GUARDIAN_OWNER;
        return { status: "ok", data: await deliverDigest(owner) };
      } catch (error) {
        return errorOf(error);
      }
    },
  });
  registerFollowingActions(deps.actions, following, callingChat, callingOwner);

  // Another app may remove a subscription it shares with these routines (a
  // repo's webhook), which stops them without a word. Subscribing again
  // restores it.
  const runReconcile = () =>
    void following
      .reconcile()
      .catch((error: unknown) => log.warn("follow reconcile failed", { error: messageOf(error) }));
  const firstReconcile = withoutSessionActor(() => setTimeout(runReconcile, RECONCILE_DELAY_MS));
  const reconcileTimer = withoutSessionActor(() =>
    setInterval(runReconcile, RECONCILE_INTERVAL_MS),
  );
  firstReconcile.unref?.();
  reconcileTimer.unref?.();
  // Important items owed from before a restart.
  delivery.deliverIn(BOOT_DELIVERY_DELAY_MS);

  return () => {
    clearTimeout(firstReconcile);
    clearInterval(reconcileTimer);
    batcher.stop();
    delivery.stop();
    service.attachFollowing(null);
  };
}

function followingActionConfig(
  name: string,
  description: string,
  sideEffects: "read-only" | "write",
) {
  return {
    name,
    type: "system" as const,
    description,
    // Explicit: only an agent whose allow-list names it may call it.
    visibility: "explicit" as const,
    complexity: "simple" as const,
    speed: "fast" as const,
    reliability: "high" as const,
    sideEffects,
  };
}

const errorOf = (error: unknown) => ({ status: "error" as const, error: messageOf(error) });

/** Reads a follow change from action args, with the same names the list uses. */
export function changeOf(args: Record<string, unknown>): ConciergeFollowChange {
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const kinds = record(args.kinds);
  const options = record(args.options);
  return {
    source: typeof args.source === "string" ? args.source.trim() : "",
    ...(typeof args.target === "string" && args.target.trim()
      ? { target: args.target.trim() }
      : {}),
    ...(kinds ? { kinds: kinds as Record<string, boolean> } : {}),
    ...(options ? { options } : {}),
    ...(args.preference === null || typeof args.preference === "string"
      ? { preference: args.preference as string | null }
      : {}),
    ...(typeof args.chatId === "string" && args.chatId.trim()
      ? { chatId: args.chatId.trim() }
      : {}),
  };
}

const CHANGE_SCHEMA_PROPERTIES = {
  source: {
    type: "string",
    description: `A service as ${CONCIERGE_FOLLOWING_ACTIONS.list} names it.`,
  },
  target: {
    type: "string",
    description:
      "What to follow, in the source's target format. Leave it out for a source with no target.",
  },
  kinds: {
    type: "object",
    description: "Kinds to turn on (true) or off (false), by the names the list gives.",
    additionalProperties: { type: "boolean" },
  },
  options: { type: "object", description: "Option values by the keys the list gives." },
  preference: {
    type: ["string", "null"],
    description: "The guardian's own words on what matters for this follow. Null clears it.",
  },
  chatId: {
    type: "string",
    description:
      "The Concierge chat its alerts go to, by the id <concierge_chat> or the following list gives. Left out, a new follow reports to the chat you are in, and one that exists keeps its chat.",
  },
} as const;

/**
 * The four follow operations as actions. They run in main (the coordination
 * list in apps/actions/engine.ts); every call to the connector goes through
 * `run`, outside the action's own async context.
 */
function registerFollowingActions(
  actions: { register(action: Action): void },
  following: ConciergeFollowing,
  callingChat: () => string | null,
  callingOwner: () => Promise<ConciergeOwner>,
): void {
  actions.register({
    config: followingActionConfig(
      CONCIERGE_FOLLOWING_ACTIONS.list,
      "Everything about what the Concierge follows for the guardian, in one structure: every service (connected or not, with what is missing), its account, what is followed there with its current settings, and the rules. Pass service for that service's watch catalog too: its target format, kinds and options, which a follow card is built from.",
      "read-only",
    ),
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "One service, as the list names it, with its watch catalog.",
        },
      },
    },
    execute: async (args) => {
      try {
        const service = typeof args.service === "string" && args.service ? args.service : undefined;
        return {
          status: "ok",
          data: agentViewOf(await following.list(await callingOwner()), service),
        };
      } catch (error) {
        return errorOf(error);
      }
    },
  });
  actions.register({
    config: followingActionConfig(
      CONCIERGE_FOLLOWING_ACTIONS.follow,
      "Follow something for the guardian at a source, or change a follow that exists. Kinds and options take the names the following list gives; what is left out keeps its default. Following the same target again is harmless.",
      "write",
    ),
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: CHANGE_SCHEMA_PROPERTIES,
    },
    execute: async (args) => {
      try {
        const change = changeOf(args);
        const owner = await callingOwner();
        const follow = await following.follow(change, owner);
        // Followed again from another chat: it keeps reporting where it did, and the agent asks.
        const here = callingChat() ?? mainChatIdOf(owner);
        const elsewhere = !change.chatId && follow.chat.id !== here;
        return {
          status: "ok",
          data: elsewhere
            ? {
                ...follow,
                note: `Its alerts go to the Concierge chat "${follow.chat.name}", not this one. Ask the guardian whether to move them here; ${CONCIERGE_FOLLOWING_ACTIONS.configure} with chatId "${here}" moves them.`,
              }
            : follow,
        };
      } catch (error) {
        return errorOf(error);
      }
    },
  });
  actions.register({
    config: followingActionConfig(
      CONCIERGE_FOLLOWING_ACTIONS.unfollow,
      `Stop following something for the guardian. Take source and target from ${CONCIERGE_FOLLOWING_ACTIONS.list}.`,
      "write",
    ),
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: CHANGE_SCHEMA_PROPERTIES.source,
        target: CHANGE_SCHEMA_PROPERTIES.target,
      },
    },
    execute: async (args) => {
      try {
        const { source, target } = changeOf(args);
        const result = await following.unfollow(source, target ?? "", await callingOwner());
        return result.removed
          ? { status: "ok", data: result }
          : { status: "error", error: `Nothing is followed at ${source} ${target ?? ""}`.trim() };
      } catch (error) {
        return errorOf(error);
      }
    },
  });
  actions.register({
    config: followingActionConfig(
      CONCIERGE_FOLLOWING_ACTIONS.configure,
      "Change what the Concierge follows when the guardian asks. With source (and target), change that follow's kinds, options or preference, by the names the following list gives, or move its alerts to another Concierge chat with chatId. The rules hold for every source: digestTimes (when the digest comes each day, HH:mm in the guardian's timezone) and quietHours (a daily window in which nothing urgent is told, null for off).",
      "write",
    ),
    inputSchema: {
      type: "object",
      properties: {
        ...CHANGE_SCHEMA_PROPERTIES,
        quietHours: {
          type: ["object", "null"],
          required: ["start", "end"],
          properties: {
            start: { type: "string", description: "HH:mm, 24-hour, e.g. 22:00" },
            end: { type: "string", description: "HH:mm, 24-hour, e.g. 08:00" },
          },
        },
        digestTimes: {
          type: "array",
          items: { type: "string", description: "HH:mm, 24-hour, e.g. 09:00" },
          minItems: 1,
          maxItems: CONCIERGE_FOLLOW_MAX_DIGEST_TIMES,
        },
      },
    },
    execute: async (args) => {
      try {
        const owner = await callingOwner();
        const data: Record<string, unknown> = {};
        const rulesChange = validateRulesChange(args);
        if (Object.keys(rulesChange).length > 0)
          data.rules = await following.setRules(rulesChange, owner);
        const change = changeOf(args);
        if (change.source) {
          const updated = await following.configure(change, owner);
          if (!updated) {
            return {
              status: "error",
              error:
                `Nothing is followed at ${change.source} ${change.target ?? ""}`.trim() +
                ". Follow it first.",
            };
          }
          data.follow = updated;
        }
        if (Object.keys(data).length === 0) {
          return {
            status: "error",
            error: "Name a follow (source and target) to change, or a rule.",
          };
        }
        return { status: "ok", data };
      } catch (error) {
        return errorOf(error);
      }
    },
  });
}
