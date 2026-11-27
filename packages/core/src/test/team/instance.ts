// One Rome instance for the team verifier, in a known state: the production
// HTTP app from `buildApp` over `buildTestDeps`, with the features and the kinds
// of connection the daemon mounts, a guardian seat, the dashboard email list,
// and a few seeded records whose ids fill route parameters.
//
// Every instance gets its own database, HOME and TMPDIR, so a call made on one
// leaves the next instance in the same state as the first. A product module
// that kept HOME when it loaded keeps the sandbox's (./sandbox.ts) instead.

import { guardLaunches, SANDBOX } from "./sandbox.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as HttpServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { buildApp, startApi } from "../../api/index.js";
import type { ApiDeps, ApiHandle, Feature } from "../../api/deps.js";
import { stringify as stringifyYaml } from "yaml";
import { AgentLoader } from "../../app-host/agent-loader.js";
import { buildAgentConfig, buildTestDeps, createTestDb, type TestDeps } from "../helpers.js";
import { seedBaseline } from "../seeds.js";
import { guardianAuth, visitorProfiles } from "../../db/schema.js";
import { backfillMembers } from "../../access/application/backfill-members.js";
import { CLOUD_GUARDIAN_PASSWORD_SENTINEL } from "../../access/guardian-auth-state.js";
import { feishu } from "../../connections/kinds/feishu/index.js";
import { discordApp, romeCloudDiscordApp } from "../../connections/kinds/discord-app/index.js";
import { linkedin } from "../../connections/kinds/linkedin/index.js";
import type { KindMount } from "../../connections/kind-mount.js";
import { ConnectionRegistry, DrizzleConnectionsRepository } from "../../connections/index.js";
import { SetupManager } from "../../connections/setup/manager.js";
import { CONCIERGE_AGENT_ID } from "../../webchat/privacy.js";
import type { VoiceInputSource } from "../../voice-input/voice-input-source.js";
import type { SpeakerSource } from "../../voice-output/speaker-source.js";
import { allowVerifierServer, guardNetwork } from "./network.js";

export const GUARDIAN = {
  userId: "acct-guardian",
  accountId: "acct-guardian",
  email: "guardian@team-verifier.test",
};
export const TEAMMATE = { accountId: "acct-teammate", email: "teammate@team-verifier.test" };
export const OUTSIDER = { accountId: "acct-outsider", email: "outsider@team-verifier.test" };

/** The kinds of connection the daemon mounts in `src/index.ts`, by factory
 *  name. `mountDrift` compares them with what this file mounts. Features need
 *  no such list: this file mounts the ones `src/index.ts` names. */
export const MOUNTED_KINDS = ["feishu", "discordApp", "linkedin"] as const;

export interface InstanceOptions {
  /** Emails on the dashboard list at boot. */
  dashboardEmails: string[];
  /** Seeds a guardian seat with onboarding complete. Default true. */
  guardianSeat?: boolean;
  /** Mounted after the daemon's features, for a stand-in product. */
  extraFeatures?: Feature[];
  /** Upgrade handlers attached ahead of the product's, for a stand-in product.
   *  Each answers only its own path. */
  extraUpgrades?: ExtraUpgrade[];
}

export interface ExtraUpgrade {
  path: string;
  handle(req: IncomingMessage, socket: Duplex): void;
}

export interface SeededIds {
  /** A chat every dashboard user may open. */
  chatId: string;
  /** Each caller's own Concierge chat, private to them. */
  conciergeChatIds: { guardian: string; teammate: string };
  routineId: string;
  approvalId: string;
  executionId: string;
  sentinelId: string;
}

export interface Instance {
  app: Hono;
  deps: ApiDeps;
  ids: SeededIds;
  /** Serves the instance on a loopback port, with every WebSocket upgrade
   *  handler `startApi` attaches. */
  listen(): Promise<{ port: number; server: Server; close(): Promise<void> }>;
  /** Puts the dashboard email list back to the one the instance booted with,
   *  in the database, in the live access state and in the members. */
  restoreDashboardList(): Promise<void>;
  close(): Promise<void>;
}

const SCOPED_ENV = ["HOME", "USERPROFILE", "TMPDIR", "ROME_PROFILE", "ROME_PROJECTS_ROOT", "PATH"];

// Rome Cloud's voice side, as for an account allowed to use voice. The
// verifier only opens the sockets, so no transcription or speech is reached.
const alwaysAvailableVoice: VoiceInputSource = {
  available: () => true,
  info: async () => ({ available: true, place: null }),
  open: async () => ({ ok: false, reason: "provider-unavailable" }),
};

const silentSpeaker: SpeakerSource = {
  open: async () => ({ ok: false, reason: "unavailable" }),
};

function connectionKinds(deps: TestDeps): KindMount[] {
  return [
    feishu({
      chatSettings: deps.chatSettings,
      peopleRepo: deps.peopleRepo,
      listAgents: () => deps.agentLoader.list().map((agent) => agent.name),
      hasAgent: () => false,
    }),
    discordApp({
      cloud: romeCloudDiscordApp(),
      depositUrl: async () => null,
      nameOf: async () => undefined,
    }),
    linkedin({
      syncSink: deps.linkedInStoreRepo,
      minIntervalMs: 60_000,
      maxIntervalMs: 120_000,
    }),
  ];
}

// The modules a daemon feature can come from: `src/<folder>/index.ts` or
// `src/<folder>/<feature>/index.ts`. Loaded only when the daemon names one, so
// a feature the daemon drops is neither built nor imported here.
interface ModuleContext {
  keys(): string[];
  (key: string): Promise<Record<string, unknown>>;
}
const featureModules = (
  import.meta as unknown as {
    webpackContext(dir: string, options: object): ModuleContext;
  }
).webpackContext("../..", {
  recursive: true,
  regExp: /^\.\/[\w-]+(\/[\w-]+)?\/index\.ts$/,
  mode: "lazy",
});

interface DaemonFeature {
  /** The factory's name in the daemon's list. */
  name: string;
  /** Its module, as a key of `featureModules`, or null when it is not one. */
  module: string | null;
}

/** The features the daemon mounts in `src/index.ts`, with the module each
 *  factory is imported from there. Null when the file has no list, as when
 *  Rome mounts no features. */
function daemonFeatures(indexSource: string): DaemonFeature[] | null {
  const names = listAfter(indexSource, FEATURES_MARKER);
  if (names === null) return null;
  return names.map((name) => {
    const from = new RegExp(
      `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"\\./([^"]+)\\.js"`,
    ).exec(indexSource);
    const key = from ? `./${from[1]}.ts` : null;
    return { name, module: key && featureModules.keys().includes(key) ? key : null };
  });
}

async function features(deps: ApiDeps): Promise<Feature[]> {
  const mounted: Feature[] = [];
  for (const { name, module } of daemonFeatures(readDaemonSource()) ?? []) {
    if (!module) continue;
    const factory = (await featureModules(module))[name];
    if (typeof factory !== "function") throw new Error(`${module} exports no ${name}`);
    mounted.push(factory(deps) as Feature);
  }
  return mounted;
}

export async function createInstance(options: InstanceOptions): Promise<Instance> {
  const releaseNetwork = guardNetwork();
  const releaseLaunches = guardLaunches();
  const root = mkdtempSync(join(tmpdir(), "rome-team-verifier-"));
  const saved = new Map(SCOPED_ENV.map((key) => [key, process.env[key]]));
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = process.env.HOME;
  process.env.TMPDIR = join(root, "tmp");
  process.env.ROME_PROFILE = `team-verifier-${randomUUID()}`;
  process.env.ROME_PROJECTS_ROOT = join(root, "projects");
  // Only the sandbox's stubs are on PATH, so a route that looks for a CLI
  // finds the same programs on every host.
  process.env.PATH = SANDBOX.bin;
  for (const dir of [process.env.HOME, process.env.TMPDIR, process.env.ROME_PROJECTS_ROOT]) {
    mkdirSync(dir, { recursive: true });
  }

  const testDb = createTestDb();
  const db = testDb.db;
  if (options.guardianSeat !== false) {
    await db.insert(guardianAuth).values({
      id: randomUUID(),
      userId: GUARDIAN.userId,
      passwordHash: CLOUD_GUARDIAN_PASSWORD_SENTINEL,
      accountId: GUARDIAN.accountId,
      email: GUARDIAN.email,
      onboardingComplete: true,
      createdAt: new Date(0),
    });
  }
  // The daemon's startup step: the members learn the guardian's seat before
  // the deps load the dashboard snapshot from them.
  await backfillMembers(db);
  const baseline = await seedBaseline(db);

  const testDeps = await buildTestDeps(db);
  // The invited emails are saved as the Settings page saves them, so the
  // invited person is a member.
  await saveDashboardList(testDeps, options.dashboardEmails);
  // The daemon loads `main` and the Concierge from the installed first-party
  // apps, which this instance has none of. Agents that may call every action
  // stand in, so the routes that read a chat's agent answer.
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir);
  for (const name of ["main", "concierge"]) {
    writeFileSync(
      join(agentsDir, `${name}.yaml`),
      stringifyYaml(buildAgentConfig({ name, actions: ["*"] })),
    );
  }
  if (!(testDeps.agentLoader instanceof AgentLoader)) {
    throw new Error("the test deps no longer build a real agent loader");
  }
  await testDeps.agentLoader.loadAll(agentsDir);
  const kinds = connectionKinds(testDeps);
  // The registry and setups as the daemon builds them, with the mounted kinds
  // registered, so the connection and setup routes answer instead of 404.
  const connectionRegistry = new ConnectionRegistry({
    repository: new DrizzleConnectionsRepository(db),
  });
  for (const kind of kinds) {
    if (kind.descriptor) connectionRegistry.register(kind.descriptor);
  }
  const deps: ApiDeps = {
    ...testDeps,
    connectionKinds: kinds,
    connectionRegistry,
    setupManager: new SetupManager({ registry: connectionRegistry }),
    voiceInput: alwaysAvailableVoice,
    speaker: silentSpeaker,
  };
  deps.features = [...(await features(deps)), ...(options.extraFeatures ?? [])];

  // A signed-in teammate has a profile: the sign-in callback keeps it, and Rome
  // reads a chat owner's email from it.
  await db
    .insert(visitorProfiles)
    .values({ accountId: TEAMMATE.accountId, email: TEAMMATE.email, updatedAt: new Date() });

  const chatId = randomUUID();
  await deps.webchatRepo.createSession(chatId, "Team verifier chat");
  const conciergeChat = async (ownerKey: string | null) => {
    const id = randomUUID();
    await deps.webchatRepo.createSession(
      id,
      "Team verifier Concierge chat",
      undefined,
      undefined,
      null,
      undefined,
      CONCIERGE_AGENT_ID,
      "webchat",
      null,
      { ownerKey },
    );
    return id;
  };
  const conciergeChatIds = {
    guardian: await conciergeChat(null),
    teammate: await conciergeChat(`visitor:${TEAMMATE.accountId}`),
  };
  const routineId = await testDeps.routinesRepo.create({
    name: "Team verifier routine",
    trigger: {
      type: "schedule",
      tzid: "UTC",
      tzMode: "fixed",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    },
    actionName: "verifier_noop",
    args: {},
    chatId: null,
  });
  const ids: SeededIds = {
    chatId,
    conciergeChatIds,
    routineId,
    approvalId: baseline.approvals.pendingId,
    executionId: baseline.actionExecutions.rootSuccessId,
    sentinelId: baseline.sentinelLog.unknownSenderId,
  };

  const { app } = buildApp(deps, { port: 0, host: "127.0.0.1" });
  const servers: ApiHandle[] = [];

  return {
    app,
    deps,
    ids,
    async listen() {
      // `startApi` keeps its server to itself, so catch it as the upgrade
      // handlers attach to it.
      let server: Server | undefined;
      const original = HttpServer.prototype.on;
      HttpServer.prototype.on = function (this: Server, event: string, listener: never) {
        if (event === "upgrade") server = this;
        return original.call(this, event, listener);
      } as typeof original;
      let handle: ApiHandle;
      try {
        handle = await startApi({ port: 0, host: "127.0.0.1" }, deps);
      } finally {
        HttpServer.prototype.on = original;
      }
      const disallow = allowVerifierServer(handle.port);
      const close = async () => {
        disallow();
        await handle.close();
      };
      servers.push({ ...handle, close });
      if (!server) throw new Error("startApi attached no upgrade handler");
      for (const extra of options.extraUpgrades ?? []) {
        server.prependListener("upgrade", (req: IncomingMessage, socket: Duplex) => {
          if (req.url?.split("?")[0] === extra.path) extra.handle(req, socket);
        });
      }
      return { port: handle.port, server, close };
    },
    async restoreDashboardList() {
      await saveDashboardList(deps, options.dashboardEmails);
    },
    async close() {
      for (const server of servers) await server.close().catch(() => {});
      testDb.close();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
      releaseLaunches();
      releaseNetwork();
    },
  };
}

// What the PUT /api/dashboard-access handler does with a list, short of
// pushing it to Rome Cloud: the members become the persons behind `emails`
// and the auth-edge snapshot is reloaded from them.
async function saveDashboardList(
  deps: Pick<TestDeps, "db" | "dashboardAccessStore" | "dashboardAccessState">,
  emails: string[],
): Promise<void> {
  await deps.dashboardAccessStore.save({ cloudEmailAccess: emails });
  await deps.dashboardAccessState.load(deps.db);
}

/**
 * Names in the daemon's mount lists that this file does not mount, or mounts
 * without the daemon. Read from `src/index.ts`, so a feature or a kind added
 * there shows up here as drift instead of as routes the verifier never sees.
 * A feature is drift only when its module cannot be found, since this file
 * mounts every feature the daemon names.
 */
export function mountDrift(indexSource: string = readDaemonSource()): string[] {
  const drift: string[] = [];
  const features = daemonFeatures(indexSource);
  // No list is drift only when the daemon still sets features some other way.
  if (features === null && indexSource.includes("apiDeps.features")) {
    drift.push(`<marker not found: ${FEATURES_MARKER}>`);
  }
  for (const { name, module } of features ?? []) {
    if (!module) drift.push(`feature ${name} not mounted`);
  }
  const kinds = listAfter(indexSource, KINDS_MARKER) ?? [`<marker not found: ${KINDS_MARKER}>`];
  for (const name of kinds)
    if (!(MOUNTED_KINDS as readonly string[]).includes(name))
      drift.push(`kind ${name} not mounted`);
  for (const name of MOUNTED_KINDS)
    if (!kinds.includes(name)) drift.push(`kind ${name} not in daemon`);
  return drift;
}

const FEATURES_MARKER = "apiDeps.features = [";
const KINDS_MARKER = "const connectionKinds: KindMount[] = [";

/** The factory names in the array literal that `marker` opens in the daemon's
 *  source, or null when the marker is not there. */
function listAfter(indexSource: string, marker: string): string[] | null {
  const start = indexSource.indexOf(marker);
  if (start === -1) return null;
  // Each marker ends with the array literal's opening bracket.
  const open = start + marker.length - 1;
  let depth = 0;
  let end = open;
  for (; end < indexSource.length; end++) {
    const ch = indexSource[end];
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    if (ch === "]" || ch === ")" || ch === "}") depth--;
    if (depth === 0) break;
  }
  const body = indexSource.slice(open + 1, end);
  // Entries are calls at the top level of the array literal: `name(`.
  const names: string[] = [];
  let level = 0;
  const tokens = body.matchAll(/([A-Za-z_$][\w$]*)\s*\(|[()[\]{}]/g);
  for (const token of tokens) {
    const text = token[0];
    if (token[1]) {
      if (level === 0) names.push(token[1]);
      level++;
    } else if (text === "(" || text === "[" || text === "{") level++;
    else level--;
  }
  return names;
}

function readDaemonSource(): string {
  // Rstest runs from packages/core.
  return readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
}
