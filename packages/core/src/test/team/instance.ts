// One Rome instance for the team verifier, in a known state: the production
// HTTP app from `buildApp` over `buildTestDeps`, with the features and the kinds
// of connection the daemon mounts, a guardian seat, the dashboard email list,
// and a few seeded records whose ids fill route parameters.
//
// Every instance gets its own database, HOME and TMPDIR, so a call made on one
// leaves the next instance in the same state as the first.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as HttpServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { buildApp, startApi } from "../../api/index.js";
import type { ApiDeps, ApiHandle, Feature } from "../../api/deps.js";
import { buildTestDeps, createTestDb, type TestDeps } from "../helpers.js";
import { seedBaseline } from "../seeds.js";
import { guardianAuth, settings } from "../../db/schema.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "../../access/dashboard-access-config.js";
import { CLOUD_GUARDIAN_PASSWORD_SENTINEL } from "../../access/guardian-auth-state.js";
import { isGuardianSession } from "../../access/session-actor.js";
import { linkCode } from "../../people/link-code/index.js";
import { phoneBook } from "../../people/phone-book/index.js";
import { personHistory } from "../../people/person-history/index.js";
import { feishu } from "../../connections/kinds/feishu/index.js";
import { discordApp, romeCloudDiscordApp } from "../../connections/kinds/discord-app/index.js";
import { linkedin } from "../../connections/kinds/linkedin/index.js";
import type { KindMount } from "../../connections/kind-mount.js";
import { ownerOfChat } from "../../webchat/owner.js";
import type { VoiceInputSource } from "../../voice-input/voice-input-source.js";
import type { SpeakerSource } from "../../voice-output/speaker-source.js";

export const GUARDIAN = {
  userId: "acct-guardian",
  accountId: "acct-guardian",
  email: "guardian@team-verifier.test",
};
export const TEAMMATE = { accountId: "acct-teammate", email: "teammate@team-verifier.test" };
export const OUTSIDER = { accountId: "acct-outsider", email: "outsider@team-verifier.test" };

/** The daemon's mount lists in `src/index.ts`, by factory name. `mountDrift`
 *  compares them with what this file mounts. */
export const MOUNTED_FEATURES = ["linkCode", "phoneBook", "personHistory"] as const;
export const MOUNTED_KINDS = ["feishu", "discordApp", "linkedin"] as const;

export interface InstanceOptions {
  /** Emails on the dashboard list at boot. */
  dashboardEmails: string[];
  /** Seeds a guardian seat with onboarding complete. Default true. */
  guardianSeat?: boolean;
}

export interface SeededIds {
  chatId: string;
  routineId: string;
  approvalId: string;
  personId: string;
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
  close(): Promise<void>;
}

const SCOPED_ENV = ["HOME", "USERPROFILE", "TMPDIR", "ROME_PROFILE", "ROME_PROJECTS_ROOT", "PATH"];

/** Stand-ins for the CLIs Rome may spawn (`claude`, `codex`): each exits 1, so no
 *  route reaches a real binary or the account it is signed in to. */
function stubBin(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["claude", "codex", "opencli"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  return bin;
}

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

function features(deps: ApiDeps): Feature[] {
  return [
    linkCode({ ...deps, isGuardian: isGuardianSession }),
    phoneBook({
      ...deps,
      ownerOfChat: (chatId) => ownerOfChat((id) => deps.webchatRepo.getSession(id), chatId),
    } as Parameters<typeof phoneBook>[0]),
    personHistory(deps as Parameters<typeof personHistory>[0]),
  ];
}

let networkGuarded = false;

/** Lets `fetch` reach loopback only, where the stand-ins listen. A route that
 *  calls Rome Cloud or a provider gets a network error instead of the internet. */
function guardNetwork(): void {
  if (networkGuarded) return;
  networkGuarded = true;
  const loopbackFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new TypeError(`fetch failed: the team verifier keeps ${url.host} unreachable`);
    }
    return loopbackFetch(input, init);
  }) as typeof fetch;
}

export async function createInstance(options: InstanceOptions): Promise<Instance> {
  guardNetwork();
  const root = mkdtempSync(join(tmpdir(), "rome-team-verifier-"));
  const saved = new Map(SCOPED_ENV.map((key) => [key, process.env[key]]));
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = process.env.HOME;
  process.env.TMPDIR = join(root, "tmp");
  process.env.ROME_PROFILE = `team-verifier-${randomUUID()}`;
  process.env.ROME_PROJECTS_ROOT = join(root, "projects");
  process.env.PATH = `${stubBin(root)}:${saved.get("PATH") ?? ""}`;
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
  // Written before the deps are built: they load the list at boot as the daemon does.
  await db.insert(settings).values({
    key: DASHBOARD_ACCESS_SETTING_KEY,
    value: { cloudEmailAccess: options.dashboardEmails },
    updatedAt: new Date(0),
  });
  const baseline = await seedBaseline(db);

  const testDeps = await buildTestDeps(db);
  const deps: ApiDeps = {
    ...testDeps,
    connectionKinds: connectionKinds(testDeps),
    voiceInput: alwaysAvailableVoice,
    speaker: silentSpeaker,
  };
  deps.features = features(deps);

  const chatId = randomUUID();
  await deps.webchatRepo.createSession(chatId, "Team verifier chat");
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
    routineId,
    approvalId: baseline.approvals.pendingId,
    personId: baseline.persons.innerCircleId,
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
      servers.push(handle);
      if (!server) throw new Error("startApi attached no upgrade handler");
      return { port: handle.port, server, close: () => handle.close() };
    },
    async close() {
      for (const server of servers) await server.close().catch(() => {});
      testDb.close();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Names in the daemon's mount lists that this file does not mount, or mounts
 * without the daemon. Read from `src/index.ts`, so a feature or a kind added
 * there shows up here as drift instead of as routes the verifier never sees.
 */
export function mountDrift(indexSource: string = readDaemonSource()): string[] {
  const listAfter = (marker: string): string[] => {
    const start = indexSource.indexOf(marker);
    if (start === -1) return [`<marker not found: ${marker}>`];
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
  };
  const drift: string[] = [];
  const compare = (kind: string, daemon: string[], mounted: readonly string[]) => {
    for (const name of daemon)
      if (!mounted.includes(name)) drift.push(`${kind} ${name} not mounted`);
    for (const name of mounted)
      if (!daemon.includes(name)) drift.push(`${kind} ${name} not in daemon`);
  };
  compare("feature", listAfter("apiDeps.features = ["), MOUNTED_FEATURES);
  compare("kind", listAfter("const connectionKinds: KindMount[] = ["), MOUNTED_KINDS);
  return drift;
}

function readDaemonSource(): string {
  // Rstest runs from packages/core.
  return readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
}
