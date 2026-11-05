import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ConciergeWatchCapability } from "@rome/api-types/concierge";
import type { Action } from "../actions/types.js";
import type { AgentRunnerInterface } from "../core/types.js";
import { ConciergeFollowItemsRepository } from "../db/repositories/concierge-follow-items.js";
import { createTestDb } from "../test/helpers.js";
import type { Routine } from "../routines/types.js";
import {
  type ConciergeFollowing,
  type ConciergeFollowingDeps,
  type ProviderSources,
  startConciergeFollowing,
  validateRulesChange,
  watchProvidersOf,
  type WatchSource,
} from "./following.js";
import type { ConnectionView } from "../api/routes/connections.js";
import type { ConciergeService } from "./service.js";

const repoTrigger = (type: string) => ({
  eventName: `provider:event:github.${type}`,
  filter: [{ field: "repository.full_name", equals: "{target}" }],
});

/** A Composio service as the connector lists it. */
const composio = (service: string, label: string, working: boolean) => ({
  service,
  label,
  state: working ? ("working" as const) : null,
  connect: working
    ? null
    : {
        kind: "composio" as const,
        method: "POST" as const,
        path: "/api/apps/connector/connectors",
        body: { provider: service },
        needsLogin: false,
        login: { method: "POST" as const, path: "/api/apps/connector/login/start" },
      },
});

/** Rome's connections as `GET /connections` lists them, trimmed to what the merge reads. */
const connectionViews = (): ConnectionView[] =>
  [
    {
      id: "c1",
      connectionKind: "github",
      label: "GitHub",
      state: "working",
      display: { github: { displayName: null, handle: "octo-me", email: null, avatarUrl: null } },
      account: null,
      connect: { url: "https://cloud/oauth/github", available: true, unavailableReason: null },
      capabilities: {
        chat: { state: "unsupported" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
    },
    {
      id: null,
      connectionKind: "telegram_user",
      label: "Telegram",
      state: null,
      display: {},
      account: null,
      connect: null,
      capabilities: {
        chat: { state: "needs-auth", missingGrants: ["telegram"] },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
    },
  ] as unknown as ConnectionView[];

/** What the connector's `sources` answers, trimmed to what the tests need. */
const sources = (
  gmailStatus: WatchSource["status"] = "ready",
  undelivered?: WatchSource["undelivered"],
): ProviderSources => ({
  services: [
    composio("gmail", "Gmail", gmailStatus !== "not_connected"),
    composio("notion", "Notion", true),
  ],
  watch: [
    {
      service: "github",
      label: "GitHub",
      status: "ready",
      account: "octo-me",
      target: { format: "A repository as owner/name", example: "rome-os/rome" },
      kinds: [
        {
          kind: "review_requested",
          label: "Review requested of you",
          default: true,
          triggers: [repoTrigger("pull_request")],
        },
        {
          kind: "your_pr_closed",
          label: "Your PRs merged or closed",
          default: true,
          triggers: [repoTrigger("pull_request")],
        },
        {
          kind: "your_ci_failed",
          label: "Your CI runs that failed",
          default: true,
          triggers: [repoTrigger("workflow_run")],
        },
        {
          kind: "new_pr_or_issue",
          label: "New PRs and issues",
          default: false,
          requires: { option: "scope", value: "whole_repo" },
          triggers: [repoTrigger("issues"), repoTrigger("pull_request")],
        },
      ],
      options: [
        {
          key: "scope",
          label: "What to hear about",
          type: "enum",
          values: [
            { value: "about_me", label: "Only what concerns me" },
            { value: "whole_repo", label: "Also the whole repository" },
          ],
          default: "about_me",
        },
        {
          key: "ignorePeople",
          label: "Ignore these people",
          type: "list",
          default: [],
        },
      ],
    },
    {
      service: "gmail",
      label: "Gmail",
      status: gmailStatus,
      ...(gmailStatus === "ready"
        ? { account: "me@example.com" }
        : { statusReason: "Gmail is not connected." }),
      ...(undelivered ? { undelivered } : {}),
      target: null,
      kinds: [
        {
          kind: "new_mail",
          label: "New mail from people",
          default: true,
          triggers: [{ eventName: "provider:event:gmail.gmail_new_gmail_message" }],
        },
      ],
      options: [
        {
          key: "recipients",
          label: "Mail sent to",
          type: "enum",
          values: [
            { value: "to_and_cc", label: "Me, or with me in cc" },
            { value: "to", label: "Me directly" },
          ],
          default: "to_and_cc",
        },
      ],
    },
  ],
});

function setup(
  options: {
    refuse?: string;
    gmailStatus?: WatchSource["status"];
    /** The Gmail kinds the connector says are not delivered. */
    gmailUndelivered?: WatchSource["undelivered"];
    /** The connectors a second provider app lists. */
    second?: ProviderSources;
    /** Triage's decision per event id; important when not named. */
    triage?: Record<string, "important" | "digest" | "ignore">;
  } = {},
) {
  /** The Concierge chats that exist and are not archived; "calendar" is a topic chat. */
  const liveChats = new Map([
    ["concierge", { id: "concierge", name: "Concierge", main: true }],
    ["calendar", { id: "calendar", name: "Calendar", main: false }],
  ]);
  /** The chat whose turn calls the follow actions. */
  const calling = { chat: null as string | null };
  /** The chat each Concierge turn ran in, in order. */
  const turnChats: string[] = [];
  const routines = new Map<string, Routine>();
  const active = new Set<string>();
  const settings = new Map<string, unknown>();
  const actions: Action[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const omitted: [string, string[]][] = [];
  const turns: string[] = [];
  /** While on, every Concierge turn fails to run to its end. */
  const turnFails = { on: false };
  const inputLabels: (string | undefined)[] = [];
  const triaged: string[][] = [];
  const prompts: string[] = [];
  const testDb = createTestDb();
  const items = new ConciergeFollowItemsRepository(testDb.db);
  const agentRunner: AgentRunnerInterface = {
    run: (params) =>
      (async function* () {
        const ids = [...params.prompt.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1] as string);
        triaged.push(ids);
        prompts.push(params.prompt);
        yield {
          type: "result",
          content: JSON.stringify({
            items: ids.map((id) => ({
              id,
              decision: options.triage?.[id] ?? "important",
              reason: "because",
              line: `line for ${id}`,
            })),
          }),
        } as never;
      })(),
  };
  let following: ConciergeFollowing | null = null;
  let nextId = 0;
  const failedReads = new Set<string>();
  const deps: ConciergeFollowingDeps = {
    routines: {
      create: async (data) => {
        const id = `r${nextId++}`;
        routines.set(id, { ...data, id, enabled: data.enabled ?? true, createdAt: new Date() });
        return id;
      },
      findByKey: async (key) => [...routines.values()].find((r) => r.key === key) ?? null,
      findById: (async (id: string) => {
        const r = routines.get(id);
        return r
          ? { ...r, key: r.key ?? null, managedBy: null, lastFiredAt: null, nextRunAt: null }
          : null;
      }) as unknown as ConciergeFollowingDeps["routines"]["findById"],
      listRoutines: async () => [...routines.values()],
      deleteIfNoActiveRuns: async (id) => {
        routines.delete(id);
        return { status: "deleted", name: id };
      },
      update: async (id, data) => {
        const r = routines.get(id);
        if (r) routines.set(id, { ...r, ...data } as Routine);
      },
    },
    routineEngine: {
      activate: async (routine) => void active.add(routine.id),
      deactivate: async (id) => void active.delete(id),
    },
    actions: { register: (action) => void actions.push(action) },
    providers: () => [
      {
        appId: "connector",
        actions: {
          sources: "connector:connector_watch_sources",
          ensure: "connector:connector_watch_ensure",
          normalize: "connector:connector_watch_normalize",
          release: "connector:connector_watch_release",
        },
      },
      ...(options.second
        ? [
            {
              appId: "second",
              actions: {
                sources: "second:list",
                ensure: "second:ensure",
                normalize: "second:normalize",
                release: "second:release",
              },
            },
          ]
        : []),
    ],
    runAction: async (qualified, args, runOptions) => {
      if (runOptions?.omitFromRecord) omitted.push([qualified, [...runOptions.omitFromRecord]]);
      if (qualified === "second:list") {
        return { status: "ok", data: options.second ?? { services: [], watch: [] } };
      }
      const name = qualified.replace("connector:", "");
      calls.push([name, args]);
      if (name === "connector_watch_sources") {
        return { status: "ok", data: sources(options.gmailStatus, options.gmailUndelivered) };
      }
      if (name === "connector_watch_ensure") {
        return options.refuse && args.source === "github"
          ? { status: "error", error: options.refuse }
          : { status: "ok", data: { subscription: args.dryRun ? "inactive" : "created" } };
      }
      if (name === "connector_watch_normalize") {
        const payload = args.payload as {
          keep?: boolean;
          id?: string;
          kind?: string;
          actor?: string;
          byYou?: boolean;
          failOnce?: boolean;
        };
        // A read the connector needed fails the first time it is tried.
        if (payload.failOnce && payload.id && !failedReads.has(payload.id)) {
          failedReads.add(payload.id);
          throw new Error("Outlook answered 503");
        }
        return payload.keep
          ? {
              status: "ok",
              data: {
                keep: true,
                event: {
                  id: payload.id ?? "github:acme/widgets:pr:7",
                  source: "github",
                  kind: payload.kind ?? "review_requested",
                  actor: payload.actor ?? "alice",
                  subject: "Fix it",
                  url: `https://github.com/acme/widgets/pull/${payload.id ?? "7"}`,
                  byYou: payload.byYou ?? false,
                  addressedTo: "direct",
                  labels: ["pull-request", "review-requested", "Bad Label!"],
                },
              },
            }
          : { status: "ok", data: { keep: false, reason: "spam or trash" } };
      }
      return { status: "ok", data: { released: false } };
    },
    settings: {
      get: (async (key: string) =>
        settings.get(key) ?? null) as ConciergeFollowingDeps["settings"]["get"],
      set: async (key, value) => void settings.set(key, value),
    },
    connections: async () => connectionViews(),
    items,
    agentRunner,
    callingChat: () => calling.chat,
  };
  const service = {
    isEnabled: async () => true,
    findChatId: async () => "concierge",
    conciergeChat: async (id: string) => liveChats.get(id) ?? null,
    deliveryChat: async (id: string | null | undefined) =>
      id && liveChats.has(id) ? id : "concierge",
    runSystemTurn: async (
      chatId: string,
      prompt: string,
      turnOptions?: { inputLabel?: string },
    ) => {
      turnChats.push(chatId);
      turns.push(prompt);
      inputLabels.push(turnOptions?.inputLabel);
      return !turnFails.on;
    },
    attachFollowing: (attached: ConciergeFollowing | null) => (following = attached),
  } as unknown as ConciergeService;
  const stop = startConciergeFollowing(service, deps);
  const action = (name: string) => actions.find((a) => a.config.name === name)!;
  return {
    routines,
    active,
    calls,
    settings,
    action,
    turns,
    turnFails,
    inputLabels,
    triaged,
    prompts,
    omitted,
    items,
    liveChats,
    calling,
    turnChats,
    following: () => following!,
    stop: () => {
      stop();
      testDb.close();
    },
  };
}

/** The watch capability of one service in the list. */
const watchIn = (
  list: { connectors: { service: string; capabilities: { watch: unknown } }[] },
  service: string,
) =>
  list.connectors.find((c) => c.service === service)?.capabilities.watch as
    | ConciergeWatchCapability
    | undefined;

/** The keys of the follow routines (the digest routines aside). */
const keys = (s: ReturnType<typeof setup>) =>
  [...s.routines.values()]
    .map((r) => r.key)
    .filter((key) => !key?.startsWith("concierge-digest:"))
    .sort();

describe("following_list", () => {
  it("returns every source with status, offer and follows, and the rules, in one structure", async () => {
    const s = setup({ gmailStatus: "not_connected" });
    await s.following().follow({ source: "github", target: "acme/widgets" });
    const list = await s.following().list();
    expect(list.rules).toEqual({ digestTimes: ["09:00", "18:00"], quietHours: null });
    // Every service, unfiltered, watchable first, in the connection model's words.
    expect(
      list.connectors.map((x) => [x.service, x.origin, x.state, x.capabilities.watch.state]),
    ).toEqual([
      ["github", "connection", "working", "unlocked"],
      ["gmail", "composio", null, "needs-auth"],
      ["telegram_user", "connection", null, "unsupported"],
      ["notion", "composio", "working", "unsupported"],
    ]);
    const [github, gmail, telegram, notion] = list.connectors;
    expect(github?.account).toBe("octo-me");
    expect(github?.connect).toBeNull();
    expect(gmail?.connect).toMatchObject({ kind: "composio", body: { provider: "gmail" } });
    expect(telegram?.connect).toEqual({ kind: "dashboard" });
    // Chat and act come from the connection as `GET /connections` reads it.
    expect(telegram?.capabilities.chat).toEqual({
      state: "needs-auth",
      missingGrants: ["telegram"],
    });
    expect(notion?.capabilities.act).toEqual({ state: "unlocked" });
    expect(gmail?.capabilities.act).toEqual({ state: "needs-auth", missingGrants: [] });
    // The raw events behind each kind stay between core and the connector.
    expect(watchIn(list, "github")?.kinds?.[0]).toEqual({
      kind: "review_requested",
      label: "Review requested of you",
      default: true,
    });
    expect(watchIn(list, "github")?.follows).toEqual([
      {
        target: "acme/widgets",
        state: "active",
        kinds: [
          { kind: "review_requested", on: true },
          { kind: "your_pr_closed", on: true },
          { kind: "your_ci_failed", on: true },
          { kind: "new_pr_or_issue", on: false },
        ],
        options: { scope: "about_me", ignorePeople: [] },
        preference: null,
        chat: { id: "concierge", name: "Concierge", main: true },
      },
    ]);
  });
});

describe("follow", () => {
  it("checks first, then subscribes, and keeps one live routine per raw event of the kinds on", async () => {
    const s = setup();
    await s.following().follow({
      source: "github",
      target: "acme/widgets",
      options: { ignorePeople: ["dependabot"] },
      preference: "Only PRs that touch the billing code matter.",
    });
    const ensures = s.calls.filter(([name]) => name === "connector_watch_ensure");
    expect(ensures.map(([, args]) => args.dryRun)).toEqual([true, false]);
    expect(keys(s)).toEqual([
      "concierge-follow:github:acme/widgets:provider:event:github.pull_request",
      "concierge-follow:github:acme/widgets:provider:event:github.workflow_run",
    ]);
    const routine = [...s.routines.values()][0]!;
    expect(routine.actionName).toBe("core:concierge_follow_event");
    expect(routine.trigger).toEqual({
      type: "event-bus",
      eventName: "provider:event:github.pull_request",
      filter: [{ field: "repository.full_name", equals: "acme/widgets" }],
    });
    // Two follow routines, beside the two digest routines.
    expect(s.active.size).toBe(4);
    const [follow] = watchIn(await s.following().list(), "github")!.follows!;
    expect(follow?.options.ignorePeople).toEqual(["dependabot"]);
    expect(follow?.preference).toBe("Only PRs that touch the billing code matter.");
  });

  it("turns on a kind that needs an option when the option is set, and its routines with it", async () => {
    const s = setup();
    await s.following().follow({
      source: "github",
      target: "acme/widgets",
      options: { scope: "whole_repo" },
    });
    expect(keys(s)).toContain("concierge-follow:github:acme/widgets:provider:event:github.issues");
    await s.following().configure({
      source: "github",
      target: "acme/widgets",
      options: { scope: "about_me" },
    });
    expect(keys(s)).not.toContain(
      "concierge-follow:github:acme/widgets:provider:event:github.issues",
    );
  });

  it("follows the connected mailbox with no target, and refuses another one", async () => {
    const s = setup();
    expect((await s.following().follow({ source: "gmail" })).target).toBe("me@example.com");
    await expect(
      s.following().follow({ source: "gmail", target: "boss@example.com" }),
    ).rejects.toThrow(/connected to Rome, me@example.com, not boss@example.com/);
  });

  it("says a follow whose kind on is not delivered is unavailable, with the kind and what to do", async () => {
    const reason = "Its trigger is missing. Ask me to follow it again to fix it.";
    const options: Parameters<typeof setup>[0] = {};
    const s = setup(options);
    await s.following().follow({ source: "gmail" });
    const followOf = async () => watchIn(await s.following().list(), "gmail")?.follows?.[0];
    expect(await followOf()).toMatchObject({ state: "active" });
    expect((await followOf())?.reason).toBeUndefined();

    options.gmailUndelivered = { kinds: ["new_mail"], reason };
    expect(await followOf()).toMatchObject({
      state: "unavailable",
      reason: `New mail from people: ${reason}`,
    });
    // Following again subscribes, so its answer is no longer held back by the old list.
    const again = await s.following().follow({ source: "gmail" });
    expect(again.state).toBe("active");
    expect(again.reason).toBeUndefined();

    // A source that is not ready says why itself; the follow adds nothing.
    options.gmailStatus = "error";
    const notReady = await followOf();
    expect(notReady?.state).toBe("unavailable");
    expect(notReady?.reason).toBeUndefined();
  });

  it("leaves a follow active when only a kind it has off is not delivered", async () => {
    const s = setup({ gmailUndelivered: { kinds: ["other_kind"], reason: "missing" } });
    const follow = await s.following().follow({ source: "gmail" });
    expect(follow.state).toBe("active");
    expect(follow.reason).toBeUndefined();
  });

  it("says what a source needs, and leaves nothing behind on a refusal", async () => {
    const s = setup({
      refuse: "GitHub refused the webhook on acme/widgets: admin access is required",
      gmailStatus: "not_connected",
    });
    await expect(s.following().follow({ source: "slack" })).rejects.toThrow(
      'Rome cannot follow "slack". Sources that can be followed: github, gmail.',
    );
    await expect(s.following().follow({ source: "github" })).rejects.toThrow(
      /owner\/name, for example rome-os\/rome/,
    );
    await expect(s.following().follow({ source: "gmail" })).rejects.toThrow(
      "Gmail cannot be followed now: Gmail is not connected.",
    );
    await expect(s.following().follow({ source: "notion" })).rejects.toThrow(
      /Rome cannot follow "notion"/,
    );
    await expect(
      s.following().follow({ source: "github", target: "acme/widgets" }),
    ).rejects.toThrow(/admin access is required/);
    expect(s.routines.size).toBe(0);
    expect(s.settings.get("conciergeFollowing")).toBeUndefined();
  });

  it("refuses unknown kinds and options, and bad values, naming what fits", async () => {
    const s = setup();
    await expect(
      s.following().follow({ source: "github", target: "acme/widgets", kinds: { pushes: true } }),
    ).rejects.toThrow(
      'github has no kind "pushes". Its kinds: review_requested, your_pr_closed, your_ci_failed, new_pr_or_issue.',
    );
    await expect(
      s.following().follow({ source: "gmail", options: { recipients: "bcc" } }),
    ).rejects.toThrow("recipients must be one of: to_and_cc, to");
    await expect(s.following().follow({ source: "gmail", options: { vip: [] } })).rejects.toThrow(
      'gmail has no option "vip". Its options: recipients.',
    );
  });
});

describe("configure and unfollow", () => {
  it("changes a kind, an option and the preference, and drops the routines a kind no longer needs", async () => {
    const s = setup();
    await s.following().follow({ source: "github", target: "acme/widgets" });
    const updated = await s.following().configure({
      source: "github",
      target: "acme/widgets",
      kinds: { your_ci_failed: false },
      preference: "Skip docs PRs",
    });
    expect(updated?.kinds.find((k) => k.kind === "your_ci_failed")?.on).toBe(false);
    expect(updated?.preference).toBe("Skip docs PRs");
    expect(keys(s)).toEqual([
      "concierge-follow:github:acme/widgets:provider:event:github.pull_request",
    ]);
    expect(await s.following().configure({ source: "github", target: "acme/other" })).toBeNull();
  });

  it("changes the mailbox's option with no target", async () => {
    const s = setup();
    await s.following().follow({ source: "gmail" });
    const updated = await s.following().configure({
      source: "gmail",
      options: { recipients: "to" },
    });
    expect(updated?.options.recipients).toBe("to");
  });

  it("keeps both of two follows started at once", async () => {
    const s = setup();
    // Without taking turns, both read the setting before either writes it back.
    await Promise.all([
      s.following().follow({ source: "github", target: "acme/widgets" }),
      s.following().follow({ source: "github", target: "acme/gadgets" }),
      s.following().follow({ source: "gmail" }),
    ]);
    const list = await s.following().list();
    expect(
      watchIn(list, "github")
        ?.follows?.map((f) => f.target)
        .sort(),
    ).toEqual(["acme/gadgets", "acme/widgets"]);
    expect(watchIn(list, "gmail")?.follows?.map((f) => f.target)).toEqual(["me@example.com"]);
  });

  it("keeps a follow and a rules change made at once", async () => {
    const s = setup();
    await Promise.all([
      s.following().follow({ source: "github", target: "acme/widgets" }),
      s.following().setRules({ digestTimes: ["08:00"] }),
    ]);
    const list = await s.following().list();
    expect(list.rules.digestTimes).toEqual(["08:00"]);
    expect(watchIn(list, "github")?.follows?.map((f) => f.target)).toEqual(["acme/widgets"]);
  });

  it("unfollows: routines and the follow go, and the connector is told", async () => {
    const s = setup();
    await s.following().follow({ source: "gmail" });
    expect(await s.following().unfollow("gmail", "")).toEqual({ removed: true });
    expect(s.routines.size).toBe(0);
    expect(watchIn(await s.following().list(), "gmail")?.follows).toEqual([]);
    expect(s.calls.some(([name]) => name === "connector_watch_release")).toBe(true);
    expect(await s.following().unfollow("gmail", "")).toEqual({ removed: false });
  });

  it("keeps the rules with defaults, and refuses rules out of bounds", async () => {
    const s = setup();
    await s.following().setRules({ quietHours: { start: "22:00", end: "08:00" } });
    expect(await s.following().rules()).toEqual({
      digestTimes: ["09:00", "18:00"],
      quietHours: { start: "22:00", end: "08:00" },
    });
    expect(validateRulesChange({ digestTimes: ["18:30", "07:00", "07:00"] })).toEqual({
      digestTimes: ["07:00", "18:30"],
    });
    expect(() => validateRulesChange({ digestTimes: [] })).toThrow(/1 to 6/);
    expect(() => validateRulesChange({ digestTimes: ["7:00"] })).toThrow(/HH:mm/);
    // The old rate limit is no rule any more: it is ignored, not stored.
    expect(validateRulesChange({ maxTurnsPerHour: 4, minSpacingMinutes: 5 })).toEqual({});
  });
});

describe("the follow actions", () => {
  it("are explicit, so only an agent that lists them can call them", () => {
    const s = setup();
    for (const name of [
      "core:concierge_follow",
      "core:concierge_unfollow",
      "core:concierge_following_list",
      "core:concierge_following_configure",
      "core:concierge_follow_event",
      "core:concierge_digest",
    ]) {
      expect(s.action(name).config.visibility).toBe("explicit");
    }
  });

  it("follow and configure take the names the list gives, and answer errors as text", async () => {
    const s = setup();
    const follow = s.action("core:concierge_follow");
    expect(await follow.execute({ source: "slack" }, {} as never)).toMatchObject({
      status: "error",
      error: expect.stringContaining('Rome cannot follow "slack"'),
    });
    expect(
      await follow.execute(
        {
          source: "github",
          target: "acme/widgets",
          options: { ignorePeople: "dependabot, renovate" },
        },
        {} as never,
      ),
    ).toMatchObject({
      status: "ok",
      data: { options: { ignorePeople: ["dependabot", "renovate"] } },
    });
    const configure = s.action("core:concierge_following_configure");
    expect(
      await configure.execute(
        {
          source: "github",
          target: "acme/widgets",
          kinds: { your_pr_closed: false },
          digestTimes: ["08:30"],
        },
        {} as never,
      ),
    ).toMatchObject({
      status: "ok",
      data: { rules: { digestTimes: ["08:30"] }, follow: { target: "acme/widgets" } },
    });
    expect(await configure.execute({}, {} as never)).toMatchObject({ status: "error" });
  });

  it("the event action reads the event through the connector and queues it", async () => {
    const s = setup();
    await s.following().follow({
      source: "github",
      target: "acme/widgets",
      options: { ignorePeople: ["bob"] },
    });
    const event = s.action("core:concierge_follow_event");
    const run = (keep: boolean) =>
      event.execute(
        {
          source: "github",
          target: "acme/widgets",
          eventName: "provider:event:github.pull_request",
          __triggerPayload: { keep },
        },
        {} as never,
      );
    expect(await run(false)).toEqual({ status: "ok", data: { ignored: "spam or trash" } });
    expect(await run(true)).toEqual({ status: "ok", data: { queued: "review_requested" } });
    expect(await run(true)).toEqual({ status: "ok", data: { ignored: "already queued" } });
    const normalize = s.calls.find(([name]) => name === "connector_watch_normalize")!;
    // The options are no filter in code: the connector gets the kinds alone.
    expect(normalize[1]).toMatchObject({
      account: "octo-me",
      kinds: ["review_requested", "your_pr_closed", "your_ci_failed"],
    });
    expect(normalize[1]).not.toHaveProperty("options");
    expect(
      await event.execute(
        { source: "github", target: "acme/other", eventName: "x", __triggerPayload: {} },
        {} as never,
      ),
    ).toEqual({ status: "ok", data: { ignored: "not followed" } });
    s.stop();
  });
});

describe("payloads in records", () => {
  it("keeps no trigger payload in follow runs, and leaves the event out of normalize's record", async () => {
    const s = setup();
    await s.following().follow({ source: "github", target: "acme/widgets" });
    const follows = [...s.routines.values()].filter((r) => r.key?.startsWith("concierge-follow:"));
    expect(follows.length).toBeGreaterThan(0);
    expect(follows.every((r) => r.keepTriggerPayload === false)).toBe(true);
    await s.action("core:concierge_follow_event").execute(
      {
        source: "github",
        target: "acme/widgets",
        eventName: "provider:event:github.pull_request",
        __triggerPayload: { keep: true },
      },
      {} as never,
    );
    expect(s.omitted).toEqual([["connector:connector_watch_normalize", ["payload"]]]);
    s.stop();
  });

  it("turns it off at reconcile for follow routines made before, and leaves other routines alone", async () => {
    const s = setup();
    await s.following().follow({ source: "gmail" });
    const follow = [...s.routines.values()].find((r) => r.key?.startsWith("concierge-follow:"))!;
    s.routines.set(follow.id, { ...follow, keepTriggerPayload: undefined });
    s.routines.set("other", {
      id: "other",
      name: "someone else's",
      key: "briefing-1",
      enabled: true,
      trigger: { type: "event-bus", eventName: "x" },
      actionName: "noop",
      args: {},
      createdAt: new Date(),
    });
    await s.following().reconcile();
    expect(s.routines.get(follow.id)?.keepTriggerPayload).toBe(false);
    expect(s.routines.get("other")?.keepTriggerPayload).toBeUndefined();
    s.stop();
  });
});

describe("the follow pipeline", () => {
  afterEach(() => {
    rs.useRealTimers();
  });

  const fire = (
    s: ReturnType<typeof setup>,
    id: string,
    more: { kind?: string; actor?: string; byYou?: boolean } = {},
  ) =>
    s.action("core:concierge_follow_event").execute(
      {
        source: "github",
        target: "acme/widgets",
        eventName: "provider:event:github.pull_request",
        __triggerPayload: { keep: true, id, ...more },
      },
      {} as never,
    );

  it("lets a failed read reach the routine, and delivers the event its retry reads", async () => {
    rs.useFakeTimers();
    const s = setup();
    await s.following().follow({ source: "github", target: "acme/widgets" });
    const run = () =>
      s.action("core:concierge_follow_event").execute(
        {
          source: "github",
          target: "acme/widgets",
          eventName: "provider:event:github.pull_request",
          __triggerPayload: { keep: true, id: "e1", failOnce: true },
        },
        {} as never,
      );
    // The failure is thrown, not answered, so the routine engine retries the run.
    await expect(run()).rejects.toThrow("503");
    expect(await run()).toEqual({ status: "ok", data: { queued: "review_requested" } });
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.triaged).toEqual([["e1"]]);
    expect(s.turns[0]).toContain("line for e1");
    s.stop();
  });

  it("batches for five minutes, triages, tells important items and stores digest ones", async () => {
    rs.useFakeTimers();
    const s = setup({ triage: { e2: "digest", e3: "ignore" } });
    await s
      .following()
      .follow({ source: "github", target: "acme/widgets", preference: "Billing only" });
    await fire(s, "e1");
    await rs.advanceTimersByTimeAsync(60_000);
    await fire(s, "e2");
    await fire(s, "e3");
    expect(s.triaged).toEqual([]);
    await rs.advanceTimersByTimeAsync(4 * 60_000);
    expect(s.triaged).toEqual([["e1", "e2", "e3"]]);
    // The Concierge gets only the triaged line of the important item.
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toContain('delivery="important"');
    // The Concierge is told the guardian's time, not left to read the clock's UTC.
    expect(s.turns[0]).toMatch(/ now="\w{3} \d\d\/\d\d\/\d{4} \d\d:\d\d \([^)]+\)">/);
    expect(s.turns[0]).toContain("line for e1");
    expect(s.turns[0]).not.toContain("e2");
    expect(await s.items.owedToConcierge()).toEqual([]);
    // The digest owes both kept items: the important one the Concierge had, and e2.
    expect((await s.items.owedToDigest()).map((i) => i.eventId)).toEqual(["e1", "e2"]);
    // A repeat of a stored event is not triaged again.
    await fire(s, "e1");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.triaged).toHaveLength(1);
    s.stop();
  });

  it("gives every item to the next digest, important ones first, and offers each once", async () => {
    rs.useFakeTimers();
    const s = setup({ triage: { e3: "digest" } });
    await s.following().follow({ source: "github", target: "acme/widgets" });
    for (const id of ["e1", "e2", "e3"]) await fire(s, id);
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toContain("line for e1");
    expect(s.turns[0]).toContain("line for e2");
    // The important ones are not offered again with the next batch.
    await fire(s, "e4");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.turns[1]).toContain("line for e4");
    expect(s.turns[1]).not.toContain("line for e1");

    const digest = await s.action("core:concierge_digest").execute({}, {} as never);
    expect(digest).toMatchObject({ status: "ok", data: { items: 4 } });
    const turn = s.turns.at(-1)!;
    expect(turn).toContain('delivery="digest"');
    // Every item, told or not, with the important ones first and marked.
    for (const id of ["e1", "e2", "e4"]) {
      expect(turn).toMatch(new RegExp(`important="true"[^>]*>line for ${id}<`));
    }
    expect(turn.indexOf("line for e4")).toBeLessThan(turn.indexOf("line for e3"));
    expect(turn).not.toMatch(/important="true"[^>]*>line for e3</);
    expect(await s.items.owedToDigest()).toEqual([]);
    s.stop();
  });

  it("triages a large batch in runs of 50 and omits nothing", async () => {
    rs.useFakeTimers();
    const s = setup();
    await s.following().follow({ source: "github", target: "acme/widgets" });
    for (let i = 0; i < 120; i++) await fire(s, `e${i}`);
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.triaged.map((run) => run.length)).toEqual([50, 50, 20]);
    s.stop();
  });

  it("gives the triage the guardian's preference and options, and only clean labels", async () => {
    rs.useFakeTimers();
    const s = setup();
    await s.following().follow({
      source: "github",
      target: "acme/widgets",
      options: { ignorePeople: ["bob"] },
      preference: "Billing only",
    });
    await fire(s, "e1");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    const [prompt] = s.prompts;
    expect(prompt).toContain('"preference": "Billing only"');
    expect(prompt).toContain('"Ignore these people: bob"');
    expect(prompt).toContain('"account": "octo-me"');
    expect(prompt).toContain('"addressedTo": "direct"');
    expect(prompt).toContain('"review-requested"');
    expect(prompt).not.toContain("Bad Label");
    s.stop();
  });

  it("drops nothing in code: options, the guardian's own actions and anyone's events go to triage", async () => {
    rs.useFakeTimers();
    const s = setup();
    await s.following().follow({
      source: "github",
      target: "acme/widgets",
      options: { ignorePeople: ["dependabot"] },
    });
    expect(await fire(s, "own", { byYou: true })).toEqual({
      status: "ok",
      data: { queued: "review_requested" },
    });
    await fire(s, "bot", { actor: "dependabot[bot]" });
    await fire(s, "run", { byYou: true, kind: "your_ci_failed" });
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    // The model sees all three, and the options as the guardian's wishes in words.
    expect(s.triaged).toEqual([["own", "bot", "run"]]);
    const prompt = s.prompts[0]!;
    expect(prompt).toContain('"byYou": true');
    expect(prompt).toContain('"What to hear about: Only what concerns me"');
    expect(prompt).toContain('"Ignore these people: dependabot"');
    expect(prompt).not.toContain('"ignorePeople"');
    s.stop();
  });

  it("marks nothing when the Concierge's turn does not run to its end, and tries again", async () => {
    rs.useFakeTimers();
    const s = setup({ triage: { e2: "digest" } });
    await s.following().follow({ source: "github", target: "acme/widgets" });
    s.turnFails.on = true;
    await fire(s, "e1");
    await fire(s, "e2");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    // The important turn failed: e1 is still owed to the Concierge.
    expect(s.turns).toHaveLength(1);
    expect((await s.items.owedToConcierge()).map((i) => i.eventId)).toEqual(["e1"]);
    // So does the digest: nothing is marked digested.
    expect(await s.action("core:concierge_digest").execute({}, {} as never)).toEqual({
      status: "ok",
      data: { items: 0 },
    });
    expect((await s.items.owedToDigest()).map((i) => i.eventId)).toEqual(["e1", "e2"]);
    // Once turns run again, the retry delivers e1 and the digest takes both.
    s.turnFails.on = false;
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect(await s.items.owedToConcierge()).toEqual([]);
    expect(await s.action("core:concierge_digest").execute({}, {} as never)).toEqual({
      status: "ok",
      data: { items: 2 },
    });
    s.stop();
  });

  it("keeps each following turn's input in its trace, labelled", async () => {
    rs.useFakeTimers();
    const s = setup({ triage: { e2: "digest" } });
    await s.following().follow({ source: "github", target: "acme/widgets" });
    await fire(s, "e1");
    await fire(s, "e2");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    await s.action("core:concierge_digest").execute({}, {} as never);
    expect(s.inputLabels).toEqual(["Following · important (1)", "Following · digest (2)"]);
    s.stop();
  });

  it("hands the owed digest to the Concierge at a digest time, and nothing when none is owed", async () => {
    const s = setup({ triage: { e1: "digest" } });
    const digest = s.action("core:concierge_digest");
    expect(await digest.execute({}, {} as never)).toEqual({ status: "ok", data: { items: 0 } });
    expect(s.turns).toEqual([]);
    await s.items.add(
      [
        {
          eventId: "e1",
          source: "gmail",
          kind: "new_mail",
          target: "me@example.com",
          decision: "digest",
          reason: "cc",
          line: "Ana cc'd you on the offsite plan",
          url: null,
        },
      ],
      new Date(),
    );
    expect(await digest.execute({}, {} as never)).toEqual({ status: "ok", data: { items: 1 } });
    expect(s.turns[0]).toContain('delivery="digest"');
    expect(s.turns[0]).toContain("Ana cc'd you on the offsite plan");
    expect(await s.items.owedToDigest()).toEqual([]);
    s.stop();
  });

  it("keeps one digest routine per digest time while anything is followed", async () => {
    const s = setup();
    const digestKeys = () =>
      [...s.routines.values()]
        .map((r) => r.key)
        .filter((k) => k?.startsWith("concierge-digest:"))
        .sort();
    expect(digestKeys()).toEqual([]);
    await s.following().follow({ source: "gmail" });
    expect(digestKeys()).toEqual(["concierge-digest:09:00", "concierge-digest:18:00"]);
    const routine = [...s.routines.values()].find((r) => r.key === "concierge-digest:09:00")!;
    expect(routine).toMatchObject({
      actionName: "core:concierge_digest",
      trigger: { type: "schedule", localTime: "09:00", tzMode: "floating", rrule: "FREQ=DAILY" },
    });
    await s.following().setRules({ digestTimes: ["08:00"] });
    expect(digestKeys()).toEqual(["concierge-digest:08:00"]);
    await s.following().unfollow("gmail", "");
    expect(digestKeys()).toEqual([]);
    s.stop();
  });
});

describe("watchProvidersOf", () => {
  const actions = { sources: "s", ensure: "e", normalize: "j", release: "r" };
  /** The action registry's owners: each app's own actions, and one core action. */
  const owners: Record<string, { ownerType: string; ownerId: string }> = {
    "core:concierge_follow": { ownerType: "core", ownerId: "core" },
  };
  for (const [appId, names] of [
    ["connector", ["s", "e", "j", "r"]],
    ["mail", ["s", "e", "j", "r"]],
    ["sneaky", ["s", "e", "j"]],
  ] as const) {
    for (const name of names) owners[`${appId}:${name}`] = { ownerType: "app", ownerId: appId };
  }
  // An action registered under another app's name is still not this one's.
  owners["borrower:r"] = { ownerType: "app", ownerId: "connector" };
  for (const name of ["s", "e", "j"]) {
    owners[`borrower:${name}`] = { ownerType: "app", ownerId: "borrower" };
  }
  const ownerOf = (name: string) => owners[name];

  it("finds every app that declares watch, with its actions qualified by its id", () => {
    expect(
      watchProvidersOf(
        [
          { appId: "connector", manifest: { watchProvider: actions } },
          { appId: "notes", manifest: {} },
          { appId: "mail", manifest: { watchProvider: actions } },
        ],
        ownerOf,
      ),
    ).toEqual([
      {
        appId: "connector",
        actions: {
          sources: "connector:s",
          ensure: "connector:e",
          normalize: "connector:j",
          release: "connector:r",
        },
      },
      {
        appId: "mail",
        actions: { sources: "mail:s", ensure: "mail:e", normalize: "mail:j", release: "mail:r" },
      },
    ]);
  });

  it("ignores a provider that names an action it does not own", () => {
    expect(
      watchProvidersOf(
        [
          // `release` is not among its actions: core would otherwise run whatever it names.
          { appId: "sneaky", manifest: { watchProvider: actions } },
          { appId: "borrower", manifest: { watchProvider: actions } },
        ],
        ownerOf,
      ),
    ).toEqual([]);
  });

  it("merges two providers, the first winning a shared service", async () => {
    const s = setup({
      second: {
        services: [
          composio("gmail", "Other Gmail", true),
          composio("linear", "Linear", true),
          composio("telegram_user", "Telegram (Composio)", true),
        ],
        watch: [],
      },
    });
    const { connectors } = await s.following().list();
    // Telegram the toolkit is listed beside Telegram the channel.
    expect(connectors.map((c) => [c.service, c.label])).toEqual([
      ["github", "GitHub"],
      ["gmail", "Gmail"],
      ["telegram_user", "Telegram"],
      ["notion", "Notion"],
      ["linear", "Linear"],
      ["telegram_user", "Telegram (Composio)"],
    ]);
  });
});

describe("follows in several Concierge chats", () => {
  afterEach(() => {
    rs.useRealTimers();
  });

  const fire = (s: ReturnType<typeof setup>, id: string, target = "acme/widgets") =>
    s.action("core:concierge_follow_event").execute(
      {
        source: "github",
        target,
        eventName: "provider:event:github.pull_request",
        __triggerPayload: { keep: true, id },
      },
      {} as never,
    );

  const chatOf = async (s: ReturnType<typeof setup>, target: string) => {
    const list = await s.following().list();
    const watch = list.connectors.find((c) => c.service === "github")?.capabilities.watch;
    return watch?.follows?.find((f) => f.target === target)?.chat;
  };

  it("reports a new follow to the chat that asked, and the main chat when none did", async () => {
    const s = setup();
    s.calling.chat = "calendar";
    await s.following().follow({ source: "github", target: "acme/widgets" });
    s.calling.chat = null;
    await s.following().follow({ source: "github", target: "acme/other" });
    expect(await chatOf(s, "acme/widgets")).toEqual({
      id: "calendar",
      name: "Calendar",
      main: false,
    });
    expect(await chatOf(s, "acme/other")).toEqual({
      id: "concierge",
      name: "Concierge",
      main: true,
    });
    s.stop();
  });

  it("keeps a follow's chat when another chat follows it again, and says where it reports", async () => {
    const s = setup();
    s.calling.chat = "calendar";
    await s
      .action("core:concierge_follow")
      .execute({ source: "github", target: "acme/widgets" }, {} as never);
    s.calling.chat = "concierge";
    const again = await s
      .action("core:concierge_follow")
      .execute({ source: "github", target: "acme/widgets" }, {} as never);
    expect(again).toMatchObject({
      status: "ok",
      data: { chat: { id: "calendar" }, note: expect.stringContaining('chatId "concierge"') },
    });
    expect(await chatOf(s, "acme/widgets")).toMatchObject({ id: "calendar" });
    s.stop();
  });

  it("moves a follow's alerts to another chat with chatId, and refuses a chat that is not a Concierge chat", async () => {
    const s = setup();
    await s.following().follow({ source: "github", target: "acme/widgets" });
    const moved = await s
      .action("core:concierge_following_configure")
      .execute({ source: "github", target: "acme/widgets", chatId: "calendar" }, {} as never);
    expect(moved.status).toBe("ok");
    expect(await chatOf(s, "acme/widgets")).toMatchObject({ id: "calendar" });
    const refused = await s
      .action("core:concierge_following_configure")
      .execute({ source: "github", target: "acme/widgets", chatId: "task-1" }, {} as never);
    expect(refused).toMatchObject({ status: "error" });
    expect(await chatOf(s, "acme/widgets")).toMatchObject({ id: "calendar" });
    s.stop();
  });

  it("tells each chat its own follows' important items, one turn per chat, and an archived chat's to the main chat", async () => {
    rs.useFakeTimers();
    const s = setup();
    s.calling.chat = "calendar";
    await s.following().follow({ source: "github", target: "acme/widgets" });
    s.calling.chat = null;
    await s.following().follow({ source: "github", target: "acme/other" });
    await fire(s, "e1", "acme/widgets");
    await fire(s, "e2", "acme/other");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.turnChats.sort()).toEqual(["calendar", "concierge"]);
    const calendarTurn = s.turns[s.turnChats.indexOf("calendar")];
    expect(calendarTurn).toContain("line for e1");
    expect(calendarTurn).not.toContain("line for e2");
    // Archived: what still reports to it goes to the main chat.
    s.liveChats.delete("calendar");
    s.turnChats.length = 0;
    await fire(s, "e3", "acme/widgets");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.turnChats).toEqual(["concierge"]);
    s.stop();
  });

  it("digests every chat's items in the main chat, grouped by chat", async () => {
    rs.useFakeTimers();
    const s = setup({ triage: { e1: "digest", e2: "digest" } });
    s.calling.chat = "calendar";
    await s.following().follow({ source: "github", target: "acme/widgets" });
    s.calling.chat = null;
    await s.following().follow({ source: "github", target: "acme/other" });
    await fire(s, "e1", "acme/widgets");
    await fire(s, "e2", "acme/other");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    s.turnChats.length = 0;
    await s.action("core:concierge_digest").execute({}, {} as never);
    expect(s.turnChats).toEqual(["concierge"]);
    const digest = s.turns.at(-1) ?? "";
    expect(digest).toContain('<chat id="calendar" name="Calendar" main="false">');
    expect(digest).toContain('<chat id="concierge" name="Concierge" main="true">');
    expect(digest.indexOf("line for e2")).toBeLessThan(digest.indexOf('name="Calendar"'));
    s.stop();
  });

  it("moves a retired chat's follows and owed items to the main chat", async () => {
    rs.useFakeTimers();
    const s = setup({ triage: { e1: "digest" } });
    s.calling.chat = "calendar";
    await s.following().follow({ source: "github", target: "acme/widgets" });
    await fire(s, "e1", "acme/widgets");
    await rs.advanceTimersByTimeAsync(5 * 60_000);
    expect((await s.items.owedToDigest()).map((i) => i.chatId)).toEqual(["calendar"]);
    expect(await s.following().moveToMainChat("calendar")).toBe(1);
    expect(await chatOf(s, "acme/widgets")).toMatchObject({ id: "concierge", main: true });
    expect((await s.items.owedToDigest()).map((i) => i.chatId)).toEqual([null]);
    s.stop();
  });
});
