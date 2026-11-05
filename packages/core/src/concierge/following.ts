// What the Concierge follows for the guardian. What can be followed belongs to
// the connections: the connector app answers which services it connects and,
// for each one it can watch, its status, kinds and options
// (`connector_watch_sources`), subscribes at the source
// (`connector_watch_ensure`), and puts each raw event in the common shape
// (`connector_watch_normalize`). Core never names a source. It keeps the
// follows and one event-bus routine per raw event a follow listens on. Events
// are batched, triaged by the `concierge-triage` agent (triage.ts), and what
// triage kept reaches the Concierge as quiet system turns: important ones after
// each batch, in the Concierge chat each follow reports to, and digest ones at
// the guardian's digest times, in the main chat (alerts.ts).

import { AsyncLocalStorage } from "node:async_hooks";
import {
  CONCIERGE_CHAT_ID,
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
import { actionExecutionContext } from "../actions/context.js";
import type { Action } from "../actions/types.js";
import type { AgentRunnerInterface } from "../core/types.js";
import type { ConciergeFollowItemsRepository } from "../db/repositories/concierge-follow-items.js";
import { type RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { RoutineEngine } from "../routines/engine.js";
import { resolveGuardianTimezone } from "../routines/guardian-timezone.js";
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
import { mergeConnectors, type ProviderService, type ProviderWatchSection } from "./connectors.js";
import { addressedToOf, cleanLabels } from "./event-shape.js";
import { optionValue, renderOptions } from "./follow-options.js";
import type { ConciergeService } from "./service.js";
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

/** One follow, as stored. */
interface FollowRecord {
  source: string;
  target: string;
  account: string;
  /** The kinds on. */
  kinds: string[];
  options: Record<string, unknown>;
  preference: string | null;
  /** The Concierge chat its alerts go to. Null is the main chat. */
  chat: string | null;
}

interface StoredFollowing extends ConciergeFollowRules {
  follows: FollowRecord[];
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

/** What the Concierge's actions and the connectors route reach. */
export interface ConciergeFollowing {
  /** Every service with its state, connect entry and capabilities (watch with its follows), and the rules. */
  list(): Promise<ConciergeConnectorsResponse>;
  /** Follows a target, or changes a follow that exists. Throws with what the source needs. */
  follow(change: ConciergeFollowChange): Promise<ConciergeFollowDto>;
  /** Changes a follow that exists. Null when it does not. */
  configure(change: ConciergeFollowChange): Promise<ConciergeFollowDto | null>;
  /**
   * Stops following. The subscription at the source stays: a GitHub webhook or
   * a Gmail trigger may serve other apps too (rome-os/rome#1658).
   */
  unfollow(source: string, target: string): Promise<{ removed: boolean }>;
  rules(): Promise<ConciergeFollowRules>;
  /** Changes the fields given and answers the rules as stored. */
  setRules(input: Partial<ConciergeFollowRules>): Promise<ConciergeFollowRules>;
  /** Subscribes every follow again, for one whose subscription another app removed. */
  reconcile(): Promise<void>;
  /** Moves the follows and owed events of Concierge chat `chatId` to the main chat. Answers how many follows moved. */
  moveToMainChat(chatId: string): Promise<number>;
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

  // Read at boot and kept current by every write, since scheduling reads it synchronously.
  let rules = CONCIERGE_FOLLOW_DEFAULT_RULES;
  const readStored = async (): Promise<StoredFollowing> => {
    const value = await deps.settings.get(CONCIERGE_FOLLOWING_SETTING_KEY);
    return { ...parseFollowRules(value), follows: parseFollows(value) };
  };
  const writeStored = async (next: StoredFollowing) => {
    await deps.settings.set(CONCIERGE_FOLLOWING_SETTING_KEY, next);
    rules = parseFollowRules(next);
  };
  void readStored()
    .then((stored) => {
      rules = parseFollowRules(stored);
    })
    .catch(() => undefined);

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

  const quietUntil = async (at: number) => {
    const { quietHours } = rules;
    if (!quietHours) return null;
    return quietWindowEnd(at, quietHours, await resolveGuardianTimezone(deps.settings));
  };

  /** A Concierge chat as a list shows it; one that is gone or archived reads as the main chat. */
  const chatRefOf = async (chatId: string | null): Promise<ConciergeChatRef> =>
    (chatId ? await service.conciergeChat(chatId) : null) ??
    (await service.conciergeChat(CONCIERGE_CHAT_ID)) ?? {
      id: CONCIERGE_CHAT_ID,
      name: "Concierge",
      main: true,
    };

  /** The stored form of a chat a change names: null for the main chat. Throws for any other chat. */
  const storedChatOf = async (chatId: string): Promise<string | null> => {
    const chat = await service.conciergeChat(chatId);
    if (!chat) throw new Error(`No Concierge chat ${chatId}. Name one the following list shows.`);
    return chat.main ? null : chat.id;
  };

  /** The chat a new follow reports to: the one asked for, else the chat that asked, else the main chat. */
  const chatForNewFollow = async (asked: string | undefined): Promise<string | null> => {
    if (asked) return storedChatOf(asked);
    const calling = callingChat();
    if (!calling) return null;
    const chat = await service.conciergeChat(calling);
    return chat && !chat.main ? chat.id : null;
  };

  const delivery = new ImportantDelivery({
    now,
    isEnabled: () => service.isEnabled(),
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
      // A chat that is gone or archived hands its items to the main chat.
      const chatId = await service.deliveryChat(items[0]?.chatId);
      // The Concierge decides whether to tell each item now. Either way every
      // item also goes into the next digest.
      // Its input stays in the run's trace, so Sessions shows why it said what it said.
      const at = guardianNow(now(), await resolveGuardianTimezone(deps.settings));
      const ran =
        chatId !== null &&
        (await service.runSystemTurn(chatId, renderImportantTurn(items, held, at), {
          quiet: true,
          inputLabel: `Following · important (${items.length})`,
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

  /** Triage of one batch: every event gets important, digest or ignore; the kept ones are stored. */
  const triageBatch = async (events: FollowEvent[]) => {
    if (!(await service.isEnabled())) return;
    const known = await deps.items.known(events.map((e) => e.id));
    const fresh = events.filter((e) => !known.has(e.id));
    if (fresh.length === 0) return;
    const { follows } = await readStored();
    const told = await deps.items.recentImportant(
      new Date(now() - RECENTLY_TOLD_MS),
      RECENTLY_TOLD_MAX,
    );
    const timezone = await resolveGuardianTimezone(deps.settings);
    const decisions: TriageDecision[] = [];
    const sources = await readSources().catch(() => [] as WatchSource[]);
    for (const part of chunks(fresh, MAX_EVENTS_PER_TRIAGE)) {
      const inPart = new Set(part.map((e) => `${e.source}:${e.target}`));
      const input: TriageInput = {
        events: part,
        accounts: [...new Map(part.map((e) => [e.source, e.account])).entries()].map(
          ([source, account]) => ({ source, account }),
        ),
        follows: follows
          .filter((f) => inPart.has(`${f.source}:${f.target}`))
          .map(({ source, target, kinds, options, preference }) => ({
            source,
            target,
            kinds,
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
        chatId: chatOfFollow.get(`${event.source}\u0000${event.target}`) ?? null,
      });
    }
    const stored = await deps.items.add(kept, new Date(now()));
    log.info("follow batch triaged", {
      events: fresh.length,
      important: stored.filter((i) => i.decision === "important").length,
      digest: stored.filter((i) => i.decision === "digest").length,
      ignored: fresh.length - kept.length,
    });
    await delivery.deliver();
  };

  const batcher = new FollowBatcher({
    now,
    flush: (events) => outsideAction(() => triageBatch(events)),
  });

  /** Hands the owed digest to the Concierge as one turn, or does nothing when none is owed. */
  const deliverDigest = async (): Promise<{ items: number }> => {
    if (!(await service.isEnabled())) return { items: 0 };
    const owed = await deps.items.owedToDigest();
    if (owed.length === 0) return { items: 0 };
    const chatId = await service.findChatId();
    const at = guardianNow(now(), await resolveGuardianTimezone(deps.settings));
    // The digest goes to the main chat and groups every chat's items under it.
    const chats = new Map<string, ConciergeChatRef>();
    for (const item of owed) {
      const key = item.chatId ?? "";
      if (!chats.has(key)) chats.set(key, await chatRefOf(item.chatId));
    }
    const ran =
      chatId !== null &&
      (await outsideAction(() =>
        service.runSystemTurn(
          chatId,
          renderDigestTurn(owed, at, (item) => chats.get(item.chatId ?? "")),
          {
            quiet: true,
            inputLabel: `Following · digest (${owed.length})`,
          },
        ),
      ));
    log.info("following digest", { items: owed.length, delivered: ran });
    // A digest that did not run to its end leaves its items for the next one.
    if (!ran) return { items: 0 };
    await deps.items.markDigested(
      owed.map((item) => item.id),
      new Date(now()),
    );
    await deps.items.prune(new Date(now() - KEEP_DELIVERED_MS));
    return { items: owed.length };
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

  /** One digest routine per digest time while anything is followed; none otherwise. */
  const syncDigestRoutines = async () => {
    const stored = await readStored();
    const wanted =
      stored.follows.length > 0 && (await service.isEnabled()) ? stored.digestTimes : [];
    for (const routine of await deps.routines.listRoutines()) {
      if (!routine.key?.startsWith(DIGEST_KEY_PREFIX)) continue;
      if (!wanted.includes(routine.key.slice(DIGEST_KEY_PREFIX.length))) {
        await removeRoutine(routine.id);
      }
    }
    if (wanted.length === 0) return;
    const tzid = await resolveGuardianTimezone(deps.settings);
    for (const localTime of wanted) {
      const key = `${DIGEST_KEY_PREFIX}${localTime}`;
      const trigger = {
        type: "schedule" as const,
        tzid,
        tzMode: "floating" as const,
        localTime,
        rrule: "FREQ=DAILY",
      };
      const existing = await deps.routines.findByKey(key);
      const id = existing
        ? existing.id
        : await deps.routines.create({
            name: `Concierge digest at ${localTime}`,
            key,
            trigger,
            actionName: CONCIERGE_DIGEST_ACTION,
            args: {},
          });
      if (existing) await deps.routines.update(id, { trigger, enabled: true });
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

  /** Makes the follow's routines match its kinds: one per raw event a kind on listens on. */
  const syncRoutines = async (source: WatchSource, follow: FollowRecord) => {
    const wanted = new Map<string, WatchTrigger>();
    for (const kind of source.kinds) {
      if (!follow.kinds.includes(kind.kind)) continue;
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
          name: `Concierge follows ${follow.target} (${source.label})`,
          key,
          trigger: routineTrigger,
          actionName: CONCIERGE_FOLLOW_ACTION,
          args,
          keepTriggerPayload: false,
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

  const unserialized: ConciergeFollowing = {
    async list() {
      const [{ services, watch }, stored, connections] = await Promise.all([
        readProviders(true),
        readStored(),
        deps.connections(),
      ]);
      const chats = new Map<string, ConciergeChatRef>();
      for (const follow of stored.follows) {
        const key = follow.chat ?? "";
        if (!chats.has(key)) chats.set(key, await chatRefOf(follow.chat));
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
              ? stored.follows
                  .filter((f) => f.source === service)
                  .map((f) => toDto(source, f, chats.get(f.chat ?? "") as ConciergeChatRef))
              : [];
          },
        }),
        rules: parseFollowRules(stored),
      };
    },

    async follow(change) {
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
      const existing = stored.follows.find(
        (f) => f.source === source.source && f.target === target,
      );
      const base: FollowRecord = existing ?? {
        source: source.source,
        target,
        account,
        kinds: source.kinds.filter((k) => k.default).map((k) => k.kind),
        options: {},
        preference: null,
        chat: await chatForNewFollow(change.chatId),
      };
      const next = {
        ...applyChange(source, base, change),
        account,
        // One that exists moves only when the change names a chat.
        ...(existing && change.chatId ? { chat: await storedChatOf(change.chatId) } : {}),
      };
      // Check first, so a refusal (no admin rights for a webhook) leaves nothing behind.
      await ensure(source.provider, next, true);
      await ensure(source.provider, next, false);
      await syncRoutines(source, next);
      await writeStored({
        ...stored,
        follows: [...stored.follows.filter((f) => f !== existing), next],
      });
      if (!existing) await syncDigest();
      return toDto(withArmed(source, next.kinds), next, await chatRefOf(next.chat));
    },

    async configure(change) {
      const source = await sourceOf(change.source);
      const stored = await readStored();
      const target = change.target?.trim() || (source.target ? "" : (source.account ?? ""));
      const existing = stored.follows.find(
        (f) => f.source === source.source && f.target === target,
      );
      if (!existing) return null;
      const next = {
        ...applyChange(source, existing, change),
        ...(change.chatId ? { chat: await storedChatOf(change.chatId) } : {}),
      };
      const added = next.kinds.filter((k) => !existing.kinds.includes(k));
      if (added.length > 0 && source.status === "ready") {
        await ensure(source.provider, { ...next, kinds: added }, false);
      }
      await syncRoutines(source, next);
      await writeStored({
        ...stored,
        follows: stored.follows.map((f) => (f === existing ? next : f)),
      });
      return toDto(
        withArmed(source, source.status === "ready" ? added : []),
        next,
        await chatRefOf(next.chat),
      );
    },

    async unfollow(sourceName, rawTarget) {
      const stored = await readStored();
      const target = rawTarget.trim();
      const existing = stored.follows.find(
        (f) =>
          f.source === sourceName && (f.target === target || (!target && f.target === f.account)),
      );
      const prefix = `${ROUTINE_KEY_PREFIX}${sourceName}:${existing?.target ?? target}:`;
      let removed = false;
      for (const routine of await deps.routines.listRoutines()) {
        if (!routine.key?.startsWith(prefix)) continue;
        await removeRoutine(routine.id);
        removed = true;
      }
      if (existing) {
        await writeStored({ ...stored, follows: stored.follows.filter((f) => f !== existing) });
        removed = true;
        await syncDigest();
        // Nothing is released yet; the connector answers so (rome-os/rome#1658).
        const provider = (await readSources().catch(() => [])).find(
          (s) => s.source === existing.source,
        )?.provider;
        if (provider) {
          await run(provider, "release", {
            source: existing.source,
            target: existing.target,
            consumer: CONSUMER,
          }).catch(() => undefined);
        }
      }
      return { removed };
    },

    rules: async () => {
      rules = parseFollowRules(await readStored());
      return rules;
    },

    async setRules(change) {
      const stored = await readStored();
      const next = parseFollowRules({ ...parseFollowRules(stored), ...change });
      await writeStored({ ...stored, ...next });
      if (change.digestTimes) await syncDigest();
      // A quiet window that ended or went away frees what it held.
      if (change.quietHours !== undefined) void outsideAction(() => delivery.deliver());
      return next;
    },

    async moveToMainChat(chatId) {
      const stored = await readStored();
      const moved = stored.follows.filter((f) => f.chat === chatId).length;
      if (moved > 0) {
        await writeStored({
          ...stored,
          follows: stored.follows.map((f) => (f.chat === chatId ? { ...f, chat: null } : f)),
        });
      }
      await deps.items.moveToMainChat(chatId);
      return moved;
    },

    async reconcile() {
      await syncDigest();
      await keepNoPayloads();
      if (!(await service.isEnabled())) return;
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
    follow: (change) => exclusive(() => unserialized.follow(change)),
    configure: (change) => exclusive(() => unserialized.configure(change)),
    unfollow: (source, target) => exclusive(() => unserialized.unfollow(source, target)),
    setRules: (change) => exclusive(() => unserialized.setRules(change)),
    moveToMainChat: (chatId) => exclusive(() => unserialized.moveToMainChat(chatId)),
  };
  service.attachFollowing(following);

  deps.actions.register({
    config: followingActionConfig(
      CONCIERGE_FOLLOW_ACTION,
      "Internal: hands an event from something the Concierge follows to its queue. Fired by its follow routines; not agent-callable.",
      "write",
    ),
    execute: async (args) => {
      if (!(await service.isEnabled())) {
        return { status: "ok", data: { ignored: "concierge off" } };
      }
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
      const follow = (await readStored()).follows.find(
        (f) => f.source === source && f.target === target,
      );
      if (!follow) return { status: "ok", data: { ignored: "not followed" } };
      const provider = (await readSources()).find((s) => s.source === source)?.provider;
      if (!provider) return { status: "ok", data: { ignored: "no provider watches it now" } };
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
        return { status: "ok", data: { ignored: normalized?.reason ?? "dropped" } };
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
      };
      const queued = outsideAction(() => batcher.add(event));
      return {
        status: "ok",
        data: queued ? { queued: event.kind } : { ignored: "already queued" },
      };
    },
  });
  deps.actions.register({
    config: followingActionConfig(
      CONCIERGE_DIGEST_ACTION,
      "Internal: hands the owed digest of followed events to the Concierge. Fired by its digest routines; not agent-callable.",
      "write",
    ),
    execute: async () => {
      try {
        return { status: "ok", data: await deliverDigest() };
      } catch (error) {
        return errorOf(error);
      }
    },
  });
  registerFollowingActions(deps.actions, following, callingChat);

  // Another app may remove a subscription it shares with these routines (a
  // repo's webhook), which stops them without a word. Subscribing again
  // restores it.
  const runReconcile = () =>
    void following
      .reconcile()
      .catch((error: unknown) => log.warn("follow reconcile failed", { error: messageOf(error) }));
  const firstReconcile = setTimeout(runReconcile, RECONCILE_DELAY_MS);
  const reconcileTimer = setInterval(runReconcile, RECONCILE_INTERVAL_MS);
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
 * list in actions/engine.ts); every call to the connector goes through
 * `run`, outside the action's own async context.
 */
function registerFollowingActions(
  actions: { register(action: Action): void },
  following: ConciergeFollowing,
  callingChat: () => string | null,
): void {
  actions.register({
    config: followingActionConfig(
      CONCIERGE_FOLLOWING_ACTIONS.list,
      "Everything about what the Concierge follows for the guardian, in one structure: every source (ready or not, with what is missing), its account, target format, kinds and options, what is followed there with its current settings, and the rules. Call it first for anything about following.",
      "read-only",
    ),
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      try {
        return { status: "ok", data: await following.list() };
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
        const follow = await following.follow(change);
        // Followed again from another chat: it keeps reporting where it did, and the agent asks.
        const here = callingChat() ?? CONCIERGE_CHAT_ID;
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
        const result = await following.unfollow(source, target ?? "");
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
        const data: Record<string, unknown> = {};
        const rulesChange = validateRulesChange(args);
        if (Object.keys(rulesChange).length > 0) data.rules = await following.setRules(rulesChange);
        const change = changeOf(args);
        if (change.source) {
          const updated = await following.configure(change);
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
