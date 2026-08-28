import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  ProjectDashboardChatsResponse,
  ProjectDashboardResponse,
} from "@rome/api-types/projects";
import { projectsFilesRoutes } from "./projects-files.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { SettingsRepository } from "../../db/repositories/settings.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";

// Projects-files routes over the real stack (edge-only fakes, #763): the
// projects root is a real temp directory reached via ROME_PROJECTS_ROOT,
// dashboard data comes from the production WebChatRepository on in-memory
// SQLite, git commits run the real `git` binary against a real repo, and
// file-watch events come from real chokidar reacting to real writes. The two
// remaining fakes sit on edges: a PATH-injected `rg` script (records its argv
// — the outbound contract of the search subprocess — and answers with a
// canned match) and the wall clock (fake timers pin usage-bucketing dates).

type RouteDeps = Parameters<typeof projectsFilesRoutes>[0];

// Suite-scoped real repos (created fresh per test in `beforeEach`). Hoisted to
// module scope so `buildApp` can default to them.
let webchatRepo: WebChatRepository;
let settingsRepo: SettingsRepository;

const ENV_KEYS = [
  "ROME_PROJECTS_ROOT",
  "ROME_WEBCHAT_PROJECTS_ROOT",
  "PATH",
  "RG_SPY_FILE",
] as const;

function buildApp(deps: RouteDeps = { settingsRepo, webchatRepo }) {
  return new Hono().route("/", projectsFilesRoutes(deps));
}

function textMessage(content: string): string {
  return JSON.stringify([{ type: "text", content }]);
}

function traceMessage(
  accounting: {
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
  hiddenText?: string,
): string {
  const { costUsd, ...usage } = accounting;
  const blocks: unknown[] = [];
  if (hiddenText) blocks.push({ type: "text", content: hiddenText });
  blocks.push({ type: "result", accounting: { costUsd, usage } });
  return JSON.stringify(blocks);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function initGitRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "rome-tests@example.com");
  git(dir, "config", "user.name", "Rome Tests");
  git(dir, "config", "commit.gpgsign", "false");
}

function lastCommitSubject(dir: string): string | null {
  try {
    return git(dir, "log", "-1", "--format=%s").trim();
  } catch {
    return null;
  }
}

type SseEvent = { event: string; data: string };

function parseSseChunk(chunk: string): SseEvent[] {
  return chunk
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /(?:^|\n)event: (.+)/.exec(block)?.[1] ?? "";
      const data = /(?:^|\n)data: (.+)/.exec(block)?.[1] ?? "";
      return { event, data };
    });
}

describe("Projects files API", () => {
  let sandboxDir: string;
  let projectsRoot: string;
  let rgSpyFile: string;
  let savedEnv: Record<string, string | undefined>;
  let testDb: TestDb;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    sandboxDir = mkdtempSync(join(tmpdir(), "rome-projects-route-"));
    projectsRoot = join(sandboxDir, "projects");
    mkdirSync(projectsRoot);
    rgSpyFile = join(sandboxDir, "rg-args");

    const binDir = join(sandboxDir, "bin");
    mkdirSync(binDir);
    const fakeRg = join(binDir, "rg");
    writeFileSync(
      fakeRg,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$RG_SPY_FILE"\nprintf './demo/src/app.ts:1:const label = "C++";\\n'\n`,
    );
    chmodSync(fakeRg, 0o755);

    process.env.ROME_PROJECTS_ROOT = projectsRoot;
    delete process.env.ROME_WEBCHAT_PROJECTS_ROOT;
    process.env.RG_SPY_FILE = rgSpyFile;
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    testDb = createTestDb();
    webchatRepo = new WebChatRepository(testDb.db);
    settingsRepo = new SettingsRepository(testDb.db);
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
    rmSync(sandboxDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe("GET /projects/events", () => {
    async function readSseChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
      const result = await reader.read();
      expect(result.done).toBe(false);
      return new TextDecoder().decode(result.value);
    }

    it("streams change events for watched folders only, ignoring generated dirs and deep paths", async () => {
      mkdirSync(join(projectsRoot, "demo", "src", "app"), { recursive: true });
      mkdirSync(join(projectsRoot, "demo", "node_modules"), { recursive: true });

      const res = await buildApp().request(
        "/projects/events?watch=projects/demo&watch=projects/demo/src&watch=projects/demo/src/index.ts&watch=projects/demo/node_modules",
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body!.getReader();
      await expect(readSseChunk(reader)).resolves.toContain("event: ready");

      // node_modules is never watched, and demo/src/app is one level below
      // the shallowly-watched demo/src — neither write may produce an event.
      writeFileSync(join(projectsRoot, "demo", "node_modules", "skipped.txt"), "no\n");
      writeFileSync(join(projectsRoot, "demo", "src", "app", "deep.txt"), "no\n");
      writeFileSync(join(projectsRoot, "demo", "src", "index.ts"), "export {};\n");

      const changes: SseEvent[] = [];
      while (
        !changes.some((event) => JSON.parse(event.data).path === "projects/demo/src/index.ts")
      ) {
        const result = await reader.read();
        expect(result.done).toBe(false);
        changes.push(
          ...parseSseChunk(new TextDecoder().decode(result.value)).filter(
            (event) => event.event === "change",
          ),
        );
      }

      expect(changes.map((event) => JSON.parse(event.data).path)).toEqual([
        "projects/demo/src/index.ts",
      ]);
      await reader.cancel();
    }, 30_000);
  });

  describe("GET /projects/tree", () => {
    it("loads two layers and skips generated project folders", async () => {
      mkdirSync(join(projectsRoot, "demo", "src", "app"), { recursive: true });
      mkdirSync(join(projectsRoot, "demo", ".cache"), { recursive: true });
      mkdirSync(join(projectsRoot, "demo", "node_modules", "library"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", ".env"), "TOKEN=secret\n");
      writeFileSync(join(projectsRoot, "demo", ".cache", "state.json"), "{}");
      writeFileSync(join(projectsRoot, "demo", "src", "app", "index.ts"), "export {};\n");
      writeFileSync(join(projectsRoot, "demo", "node_modules", "library", "index.js"), "");

      const res = await buildApp().request("/projects/tree?depth=2");

      expect(res.status).toBe(200);
      const tree = (await res.json()) as Array<{
        children?: Array<{ children?: unknown[]; name: string; type: string }>;
        name: string;
        type: string;
      }>;
      const demo = tree.find((node) => node.name === "demo");
      expect(demo?.children?.map((node) => node.name)).toEqual(["src"]);
      const src = demo?.children?.find((node) => node.name === "src");
      expect(src).not.toHaveProperty("children");
    });
  });

  describe("GET /projects/search", () => {
    it("matches literal search terms that contain regex characters", async () => {
      mkdirSync(join(projectsRoot, "demo", "src"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "src", "app.ts"), 'const label = "C++";\n');

      const res = await buildApp().request("/projects/search?q=C%2B%2B");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual([
        {
          content: 'const label = "C++";',
          file: "projects/demo/src/app.ts",
          line: 1,
        },
      ]);
      // The recorded argv is the outbound contract with the rg subprocess:
      // the query must be passed as a fixed string, not a regex.
      const rgArgs = readFileSync(rgSpyFile, "utf-8").trim().split("\n");
      expect(rgArgs).toContain("--fixed-strings");
      expect(rgArgs.slice(-2)).toEqual(["C++", "."]);
    });
  });

  describe("GET /projects/dashboard", () => {
    it("returns usage stats, chats, and cache hit rate for DB-backed projects", async () => {
      rs.useFakeTimers();
      rs.setSystemTime(new Date("2026-05-15T11:59:00.000Z"));
      mkdirSync(join(projectsRoot, "demo", "src"), { recursive: true });
      mkdirSync(join(projectsRoot, "demo", "node_modules", "ignored"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "src", "index.ts"), "export {};\n");
      writeFileSync(join(projectsRoot, "demo", "node_modules", "ignored", "index.js"), "");

      await webchatRepo.createSession("sess-1", "Demo chat", undefined, "demo", null, "demo");
      rs.setSystemTime(new Date("2026-05-15T11:59:10.000Z"));
      await webchatRepo.addMessage(
        "msg-user",
        "sess-1",
        "user",
        textMessage("Please inspect this project."),
      );
      rs.setSystemTime(new Date("2026-05-15T11:59:20.000Z"));
      await webchatRepo.addMessage(
        "msg-assistant",
        "sess-1",
        "assistant",
        textMessage("Found the issue."),
      );
      rs.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
      await webchatRepo.addMessage(
        "msg-trace",
        "sess-1",
        "trace",
        traceMessage(
          {
            costUsd: 0.25,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
          },
          "intermediate hidden trace content",
        ),
      );

      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      const res = await buildApp({ webchatRepo }).request("/projects/dashboard?path=projects/demo");

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body).toMatchObject({
        // "default" is the migration-seeded project row every instance has.
        availableProjectPaths: ["default", "demo"],
        name: "demo",
        logicalPath: "projects/demo",
        relativePath: "demo",
        stats: {
          cacheHitRate: 10 / 115,
          monthBudgetUsd: null,
          monthCostUsd: 0.25,
          monthTokens: 135,
          totalCostUsd: 0.25,
          totalTokens: 135,
        },
        chats: [
          {
            id: "sess-1",
            title: "Demo chat",
            messageCount: 3,
            searchText: "Please inspect this project. Found the issue.",
            snippet: "Found the issue.",
          },
        ],
      });
      expect(body.chats[0].searchText).not.toContain("intermediate hidden trace content");
      expect(body.usage.find((day) => day.date === todayKey)).toMatchObject({
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.25,
      });
    });

    it("returns aggregate usage stats and recent chats for the projects root", async () => {
      rs.useFakeTimers();
      rs.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));
      mkdirSync(join(projectsRoot, "alpha"), { recursive: true });
      mkdirSync(join(projectsRoot, "beta"), { recursive: true });

      await webchatRepo.createSession(
        "sess-alpha",
        "alpha chat",
        undefined,
        "alpha",
        null,
        "alpha",
      );
      rs.setSystemTime(new Date("2026-05-15T11:00:10.000Z"));
      await webchatRepo.addMessage(
        "msg-alpha",
        "sess-alpha",
        "user",
        textMessage("Message for sess-alpha"),
      );
      rs.setSystemTime(new Date("2026-05-15T11:00:20.000Z"));
      await webchatRepo.addMessage(
        "msg-alpha-trace",
        "sess-alpha",
        "trace",
        traceMessage({
          costUsd: 0.6,
          inputTokens: 170,
          outputTokens: 60,
          cacheReadTokens: 17,
          cacheWriteTokens: 3,
        }),
      );
      rs.setSystemTime(new Date("2026-05-15T11:01:00.000Z"));
      await webchatRepo.createSession(
        "sess-legacy",
        "Legacy chat",
        undefined,
        "legacy",
        null,
        null,
      );
      rs.setSystemTime(new Date("2026-05-15T11:01:10.000Z"));
      await webchatRepo.addMessage(
        "msg-legacy",
        "sess-legacy",
        "user",
        textMessage("Message for sess-legacy"),
      );
      rs.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));

      const res = await buildApp({ webchatRepo }).request("/projects/dashboard?path=projects");

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body).toMatchObject({
        availableProjectPaths: ["default", "alpha", "beta"],
        logicalPath: "projects",
        name: "All projects",
        relativePath: "",
        stats: {
          chatCount: 2,
          monthCostUsd: 0.6,
          monthTokens: 250,
          totalCostUsd: 0.6,
          totalTokens: 250,
        },
      });
      expect(body.stats.cacheHitRate).toBe(17 / 190);
      expect(body.chats.map((chat) => chat.id).sort()).toEqual(["sess-alpha", "sess-legacy"]);
      expect(body.chatPage).toEqual({
        hasMore: false,
        limit: 20,
        nextCursor: null,
        total: 2,
      });
      expect(body.usage.find((day) => day.date === "2026-05-15")).toMatchObject({
        cacheReadTokens: 17,
        cacheWriteTokens: 3,
        costUsd: 0.6,
        inputTokens: 170,
        outputTokens: 60,
      });
    });

    it("reports root dashboard chat totals from all sessions when recent chats are truncated", async () => {
      rs.useFakeTimers();
      const base = new Date("2026-05-15T12:00:00.000Z").getTime();
      for (let index = 1; index <= 25; index += 1) {
        rs.setSystemTime(new Date(base - index * 60_000));
        await webchatRepo.createSession(
          `sess-alpha-${String(index).padStart(2, "0")}`,
          `Alpha chat ${index}`,
          undefined,
          "alpha",
          null,
          "alpha",
        );
      }
      rs.setSystemTime(new Date(base - 26 * 60_000));
      await webchatRepo.createSession(
        "sess-beta-1",
        "Beta chat 1",
        undefined,
        "beta",
        null,
        "beta",
      );
      rs.setSystemTime(new Date(base));

      const app = buildApp({ webchatRepo });
      const res = await app.request("/projects/dashboard?path=projects");

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body.chats).toHaveLength(20);
      expect(body.stats.chatCount).toBe(26);
      expect(body.chatPage).toMatchObject({
        hasMore: true,
        limit: 20,
        total: 26,
      });
      expect(body.chatPage.nextCursor).toEqual(expect.any(String));

      const pageRes = await app.request(
        `/projects/dashboard/chats?path=projects&cursor=${encodeURIComponent(body.chatPage.nextCursor!)}&limit=20`,
      );

      expect(pageRes.status).toBe(200);
      const pageBody = (await pageRes.json()) as ProjectDashboardChatsResponse;
      expect(pageBody.chats.map((chat) => chat.id)).toEqual([
        "sess-alpha-21",
        "sess-alpha-22",
        "sess-alpha-23",
        "sess-alpha-24",
        "sess-alpha-25",
        "sess-beta-1",
      ]);
      expect(pageBody.page).toEqual({
        hasMore: false,
        limit: 20,
        nextCursor: null,
        total: 26,
      });
    });

    it("keeps aggregate usage on one day window when a root request crosses midnight", async () => {
      rs.useFakeTimers();
      rs.setSystemTime(new Date("2026-04-18T12:00:00.000Z"));
      mkdirSync(join(projectsRoot, "alpha"), { recursive: true });
      await webchatRepo.createSession(
        "sess-usage",
        "Usage chat",
        undefined,
        "alpha",
        null,
        "alpha",
      );
      await webchatRepo.addMessage(
        "msg-usage-trace",
        "sess-usage",
        "trace",
        traceMessage({ costUsd: 0.4, inputTokens: 40, outputTokens: 4 }),
      );
      await settingsRepo.set("guardianTimezone", "UTC");
      rs.setSystemTime(new Date("2026-05-01T23:59:59.000Z"));

      // The clock jumps past midnight while the usage query runs; the
      // response must keep the day window computed at request start.
      const midQueryClockSkewRepo: RouteDeps["webchatRepo"] = {
        getMessagesBatch: (sessionIds) => webchatRepo.getMessagesBatch(sessionIds),
        getProjectUsageTotals: (projectPath, options) =>
          webchatRepo.getProjectUsageTotals(projectPath, options),
        getUsageTotals: (options) => {
          rs.setSystemTime(new Date("2026-05-02T00:00:01.000Z"));
          return webchatRepo.getUsageTotals(options);
        },
        archiveProjectsByPathPrefix: (projectPath, options) =>
          webchatRepo.archiveProjectsByPathPrefix(projectPath, options),
        deleteArchivedProjectsByPathPrefix: (projectPath) =>
          webchatRepo.deleteArchivedProjectsByPathPrefix(projectPath),
        deleteSessionsByProjectPathPrefix: (projectPath) =>
          webchatRepo.deleteSessionsByProjectPathPrefix(projectPath),
        ensureProject: (projectPath, name, options) =>
          webchatRepo.ensureProject(projectPath, name, options),
        getProjectRecordByPath: (projectPath) => webchatRepo.getProjectRecordByPath(projectPath),
        listProjectPaths: () => webchatRepo.listProjectPaths(),
        listSessionRefsByProjectPathPrefix: (projectPath) =>
          webchatRepo.listSessionRefsByProjectPathPrefix(projectPath),
        listSessionsByProjectPath: (projectPath, options) =>
          webchatRepo.listSessionsByProjectPath(projectPath, options),
        listSessionsPage: (options) => webchatRepo.listSessionsPage(options),
        unarchiveProjectsByPaths: (projectPaths, options) =>
          webchatRepo.unarchiveProjectsByPaths(projectPaths, options),
      };

      const res = await buildApp({
        settingsRepo,
        webchatRepo: midQueryClockSkewRepo,
      }).request("/projects/dashboard?path=projects");

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body.usage[0]).toMatchObject({
        costUsd: 0.4,
        date: "2026-04-18",
        inputTokens: 40,
        outputTokens: 4,
      });
      expect(body.usage.at(-1)?.date).toBe("2026-05-01");
    });

    it("buckets usage and monthly spend in the guardian timezone", async () => {
      rs.useFakeTimers();
      rs.setSystemTime(new Date("2026-04-30T12:00:00.000Z"));
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      await webchatRepo.createSession("sess-1", "Demo chat", undefined, "demo", null, "demo");

      // 14:00Z is 23:00 in Tokyo (April 30, previous month); 16:00Z is 01:00
      // in Tokyo (May 1). UTC bucketing would put both on April 30.
      rs.setSystemTime(new Date("2026-04-30T14:00:00.000Z"));
      await webchatRepo.addMessage(
        "msg-trace-april",
        "sess-1",
        "trace",
        traceMessage({ costUsd: 0.1, inputTokens: 7, outputTokens: 1 }),
      );
      rs.setSystemTime(new Date("2026-04-30T16:00:00.000Z"));
      await webchatRepo.addMessage(
        "msg-trace-may",
        "sess-1",
        "trace",
        traceMessage({
          costUsd: 0.25,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
        }),
      );
      await settingsRepo.set("guardianTimezone", "Asia/Tokyo");
      rs.setSystemTime(new Date("2026-05-01T00:30:00.000Z"));

      const res = await buildApp({ settingsRepo, webchatRepo }).request(
        "/projects/dashboard?path=projects/demo",
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body.stats.monthCostUsd).toBe(0.25);
      expect(body.usage.find((day) => day.date === "2026-05-01")).toMatchObject({
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0.25,
        inputTokens: 100,
        outputTokens: 20,
      });
      expect(body.usage.find((day) => day.date === "2026-04-30")).toMatchObject({
        costUsd: 0.1,
        inputTokens: 7,
        outputTokens: 1,
      });
    });

    it("returns only the first 20 dashboard chats and loads later pages separately", async () => {
      rs.useFakeTimers();
      const base = new Date("2026-05-15T12:00:00.000Z").getTime();
      for (let index = 1; index <= 25; index += 1) {
        rs.setSystemTime(new Date(base - index * 60_000));
        await webchatRepo.createSession(
          `sess-${String(index).padStart(2, "0")}`,
          `Demo chat ${index}`,
          undefined,
          "demo",
          null,
          "demo",
        );
      }
      rs.setSystemTime(new Date(base));
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });

      const app = buildApp({ webchatRepo });
      const dashboardRes = await app.request("/projects/dashboard?path=projects/demo");

      expect(dashboardRes.status).toBe(200);
      const dashboardBody = (await dashboardRes.json()) as ProjectDashboardResponse;
      expect(dashboardBody.chats).toHaveLength(20);
      expect(dashboardBody.chats[0]?.id).toBe("sess-01");
      expect(dashboardBody.chats[19]?.id).toBe("sess-20");
      expect(dashboardBody.chatPage).toMatchObject({
        hasMore: true,
        limit: 20,
        total: 25,
      });
      expect(dashboardBody.chatPage.nextCursor).toEqual(expect.any(String));
      expect(dashboardBody.stats.chatCount).toBe(25);

      const pageRes = await app.request(
        `/projects/dashboard/chats?path=projects/demo&cursor=${encodeURIComponent(dashboardBody.chatPage.nextCursor!)}&limit=20`,
      );

      expect(pageRes.status).toBe(200);
      const pageBody = (await pageRes.json()) as ProjectDashboardChatsResponse;
      expect(pageBody.chats.map((chat) => chat.id)).toEqual([
        "sess-21",
        "sess-22",
        "sess-23",
        "sess-24",
        "sess-25",
      ]);
      expect(pageBody.page).toEqual({
        hasMore: false,
        limit: 20,
        nextCursor: null,
        total: 25,
      });
    });

    it("uses the latest user message as the snippet while waiting for the first assistant response", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      await webchatRepo.createSession(
        "sess-pending",
        "Pending chat",
        undefined,
        "demo",
        null,
        "demo",
      );
      await webchatRepo.addMessage(
        "msg-user",
        "sess-pending",
        "user",
        textMessage("Can you inspect this failure?"),
      );

      const res = await buildApp({ webchatRepo }).request("/projects/dashboard?path=projects/demo");

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body.chats[0]).toMatchObject({
        id: "sess-pending",
        searchText: "Can you inspect this failure?",
        snippet: "Can you inspect this failure?",
      });
    });

    it("returns a dashboard for folders with no DB sessions", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });

      const res = await buildApp({ webchatRepo }).request("/projects/dashboard?path=projects/demo");

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body).toMatchObject({
        chats: [],
        chatPage: {
          hasMore: false,
          nextCursor: null,
          total: 0,
        },
        logicalPath: "projects/demo",
        name: "demo",
        relativePath: "demo",
        stats: {
          cacheHitRate: 0,
          chatCount: 0,
          monthCostUsd: 0,
          totalCostUsd: 0,
          totalTokens: 0,
        },
      });
    });

    it("uses the longest session-backed project prefix for clicked child folders", async () => {
      mkdirSync(join(projectsRoot, "a", "b", "123"), { recursive: true });
      writeFileSync(join(projectsRoot, "a", "b", "123", "notes.txt"), "hello\n");
      await webchatRepo.createSession("sess-a", "A chat", undefined, "a", null, "a");
      await webchatRepo.createSession(
        "sess-nested",
        "Nested project chat",
        undefined,
        "b",
        null,
        "a/b",
      );
      await webchatRepo.createSession("sess-c", "C chat", undefined, "c", null, "c");
      await webchatRepo.createSession("sess-d", "D chat", undefined, "d", null, "d");

      const res = await buildApp({ webchatRepo }).request(
        "/projects/dashboard?path=projects/a/b/123",
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body).toMatchObject({
        availableProjectPaths: ["default", "a/b", "a", "c", "d"],
        logicalPath: "projects/a/b",
        name: "b",
        relativePath: "a/b",
        stats: {
          cacheHitRate: 0,
          chatCount: 1,
        },
      });
      expect(body.chats.map((chat) => chat.id)).toEqual(["sess-nested"]);
    });

    it("falls back to the top-level shadow project for folders without stored project records", async () => {
      mkdirSync(join(projectsRoot, "z", "child"), { recursive: true });
      await webchatRepo.createSession("sess-ab", "AB chat", undefined, "b", null, "a/b");

      const res = await buildApp({ webchatRepo }).request(
        "/projects/dashboard?path=projects/z/child",
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectDashboardResponse;
      expect(body).toMatchObject({
        availableProjectPaths: ["default", "a/b", "z"],
        chats: [],
        logicalPath: "projects/z",
        name: "z",
        relativePath: "z",
        stats: {
          cacheHitRate: 0,
          chatCount: 0,
        },
      });
    });

    it("returns an empty chat page for project folders with no sessions", async () => {
      mkdirSync(join(projectsRoot, "z"), { recursive: true });

      const res = await buildApp({ webchatRepo }).request(
        "/projects/dashboard/chats?path=projects/z",
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        chats: [],
        page: {
          hasMore: false,
          limit: 20,
          nextCursor: null,
          total: 0,
        },
      });
    });

    it("resolves clicked folders without loading dashboard details", async () => {
      mkdirSync(join(projectsRoot, "a", "b", "123"), { recursive: true });
      await webchatRepo.createSession("sess-a", "A chat", undefined, "a", null, "a");
      await webchatRepo.createSession("sess-ab", "AB chat", undefined, "b", null, "a/b");

      const res = await buildApp({ webchatRepo }).request(
        "/projects/dashboard/resolve?path=projects/a/b/123",
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        logicalPath: "projects/a/b",
        relativePath: "a/b",
      });
    });
  });

  describe("GET /projects/file", () => {
    it("returns common source files as editable text", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "main.py"), "print('hi')\n");
      writeFileSync(join(projectsRoot, "demo", "index.js"), "console.log('hi');\n");
      writeFileSync(join(projectsRoot, "demo", "server.go"), "package main\n");

      const pythonRes = await buildApp().request("/projects/file?path=projects/demo/main.py");
      expect(pythonRes.status).toBe(200);
      await expect(pythonRes.json()).resolves.toMatchObject({
        path: "projects/demo/main.py",
        kind: "text",
        editable: true,
        mimeType: "text/x-python",
        content: "print('hi')\n",
        assetUrl: null,
      });

      const javascriptRes = await buildApp().request("/projects/file?path=projects/demo/index.js");
      expect(javascriptRes.status).toBe(200);
      await expect(javascriptRes.json()).resolves.toMatchObject({
        path: "projects/demo/index.js",
        kind: "text",
        editable: true,
        mimeType: "text/javascript",
        content: "console.log('hi');\n",
        assetUrl: null,
      });

      const goRes = await buildApp().request("/projects/file?path=projects/demo/server.go");
      expect(goRes.status).toBe(200);
      await expect(goRes.json()).resolves.toMatchObject({
        path: "projects/demo/server.go",
        kind: "text",
        editable: true,
        mimeType: "text/x-go",
        content: "package main\n",
        assetUrl: null,
      });
    });

    it("returns a previewable asset for PDF files", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "brief.pdf"), "%PDF-1.4\n");

      const res = await buildApp().request("/projects/file?path=projects/demo/brief.pdf");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({
        path: "projects/demo/brief.pdf",
        kind: "pdf",
        editable: false,
        mimeType: "application/pdf",
        content: null,
      });
      expect(data.assetUrl).toMatch(
        /^\/api\/projects\/asset\/brief\.pdf\?path=projects%2Fdemo%2Fbrief\.pdf&v=\d+-9$/,
      );
    });

    it("returns editable HTML content with a previewable asset", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "index.html"), "<h1>Hello</h1>\n");

      const res = await buildApp().request("/projects/file?path=projects/demo/index.html");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({
        path: "projects/demo/index.html",
        kind: "text",
        editable: true,
        mimeType: "text/html",
        content: "<h1>Hello</h1>\n",
      });
      expect(data.assetUrl).toMatch(
        /^\/api\/projects\/asset\/index\.html\?path=projects%2Fdemo%2Findex\.html&v=\d+-15$/,
      );
    });

    it("returns a previewable asset for DOCX files", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "brief.docx"), "docx-bytes");

      const res = await buildApp().request("/projects/file?path=projects/demo/brief.docx");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({
        path: "projects/demo/brief.docx",
        kind: "docx",
        editable: false,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content: null,
      });
      expect(data.assetUrl).toMatch(
        /^\/api\/projects\/asset\/brief\.docx\?path=projects%2Fdemo%2Fbrief\.docx&v=\d+-10$/,
      );
    });

    it("returns a previewable asset for audio files", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "memo.wav"), "audio-bytes");

      const res = await buildApp().request("/projects/file?path=projects/demo/memo.wav");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({
        path: "projects/demo/memo.wav",
        kind: "audio",
        editable: false,
        mimeType: "audio/wav",
        content: null,
      });
      expect(data.assetUrl).toMatch(
        /^\/api\/projects\/asset\/memo\.wav\?path=projects%2Fdemo%2Fmemo\.wav&v=\d+-11$/,
      );
    });
  });

  describe("GET /projects/asset", () => {
    it("serves HTML assets inline", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "index.html"), "<h1>Hello</h1>\n");

      const res = await buildApp().request(
        "/projects/asset/index.html?path=projects/demo/index.html",
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        "inline; filename=\"index.html\"; filename*=UTF-8''index.html",
      );
      expect(res.headers.get("content-type")).toBe("text/html");
      expect(await res.text()).toBe("<h1>Hello</h1>\n");
    });

    it("serves PDF assets inline", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "brief.pdf"), "%PDF-1.4\n");

      const res = await buildApp().request(
        "/projects/asset/brief.pdf?path=projects/demo/brief.pdf",
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        "inline; filename=\"brief.pdf\"; filename*=UTF-8''brief.pdf",
      );
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(await res.text()).toBe("%PDF-1.4\n");
    });

    it("serves DOCX assets inline", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "brief.docx"), "docx-bytes");

      const res = await buildApp().request(
        "/projects/asset/brief.docx?path=projects/demo/brief.docx",
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        "inline; filename=\"brief.docx\"; filename*=UTF-8''brief.docx",
      );
      expect(res.headers.get("content-type")).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(await res.text()).toBe("docx-bytes");
    });

    it("keeps query-only asset URLs working for compatibility", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "brief.pdf"), "%PDF-1.4\n");

      const res = await buildApp().request("/projects/asset?path=projects/demo/brief.pdf");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        "inline; filename=\"brief.pdf\"; filename*=UTF-8''brief.pdf",
      );
      expect(res.headers.get("content-type")).toBe("application/pdf");
    });

    it("RFC 5987-encodes inline asset filenames", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      const fileName = "résumé's (final).pdf";
      const logicalPath = `projects/demo/${fileName}`;
      writeFileSync(join(projectsRoot, "demo", fileName), "%PDF-1.4\n");

      const res = await buildApp().request(
        `/projects/asset/${encodeURIComponent(fileName)}?path=${encodeURIComponent(logicalPath)}`,
      );

      expect(res.status).toBe(200);
      const expectedFilenameStar = "r%C3%A9sum%C3%A9%27s%20%28final%29.pdf";
      expect(res.headers.get("content-disposition")).toBe(
        `inline; filename="r_sum_'s (final).pdf"; filename*=UTF-8''${expectedFilenameStar}`,
      );
      expect(res.headers.get("content-type")).toBe("application/pdf");
    });

    it("serves audio assets inline", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "memo.wav"), "audio-bytes");

      const res = await buildApp().request("/projects/asset/memo.wav?path=projects/demo/memo.wav");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        "inline; filename=\"memo.wav\"; filename*=UTF-8''memo.wav",
      );
      expect(res.headers.get("content-type")).toBe("audio/wav");
      expect(await res.text()).toBe("audio-bytes");
    });
  });

  describe("GET /projects/download", () => {
    it("downloads a project file as an attachment", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "README.md"), "# Demo\n");

      const res = await buildApp().request("/projects/download?path=projects/demo/README.md");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("content-disposition")).toContain("README.md");
      expect(await res.text()).toBe("# Demo\n");
    });
  });

  describe("PUT /projects/file", () => {
    it("commits manual saves to the nearest project git repo", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      initGitRepo(join(projectsRoot, "demo"));
      writeFileSync(join(projectsRoot, "demo", "PROJECT.md"), "old\n");

      const res = await buildApp().request("/projects/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commit: true,
          content: "new\n",
          path: "projects/demo/PROJECT.md",
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Saved and committed",
        success: true,
      });
      expect(readFileSync(join(projectsRoot, "demo", "PROJECT.md"), "utf-8")).toBe("new\n");
      expect(lastCommitSubject(join(projectsRoot, "demo"))).toBe("projects: update PROJECT.md");
      expect(git(join(projectsRoot, "demo"), "show", "HEAD:PROJECT.md")).toBe("new\n");
      expect(git(join(projectsRoot, "demo"), "status", "--porcelain")).toBe("");
    });

    it("falls back to disk-only when the project has no git repo", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "PROJECT.md"), "old\n");

      const res = await buildApp().request("/projects/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commit: true,
          content: "new\n",
          path: "projects/demo/PROJECT.md",
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ message: "Saved", success: true });
      expect(readFileSync(join(projectsRoot, "demo", "PROJECT.md"), "utf-8")).toBe("new\n");
    });

    it("reports manual save failures when the project git commit fails", async () => {
      // An empty .git directory looks like a repo to the route but makes
      // every real git invocation fail.
      mkdirSync(join(projectsRoot, "demo", ".git"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "PROJECT.md"), "old\n");

      const res = await buildApp().request("/projects/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commit: true,
          content: "new\n",
          path: "projects/demo/PROJECT.md",
        }),
      });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({
        error: "Saved to disk, but failed to create git commit",
      });
      expect(readFileSync(join(projectsRoot, "demo", "PROJECT.md"), "utf-8")).toBe("new\n");
    });

    it("skips git entirely when commit is false (autosave)", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      initGitRepo(join(projectsRoot, "demo"));
      writeFileSync(join(projectsRoot, "demo", "PROJECT.md"), "old\n");

      const res = await buildApp().request("/projects/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commit: false,
          content: "draft\n",
          path: "projects/demo/PROJECT.md",
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ message: "Saved", success: true });
      expect(readFileSync(join(projectsRoot, "demo", "PROJECT.md"), "utf-8")).toBe("draft\n");
      expect(lastCommitSubject(join(projectsRoot, "demo"))).toBeNull();
    });
  });

  describe("POST /projects/file", () => {
    it("revives archived project metadata after recreating a folder", async () => {
      await webchatRepo.createProject("demo", "demo");
      await webchatRepo.archiveProjectsByPathPrefix("demo");

      const res = await buildApp().request("/projects/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "projects/demo", type: "folder" }),
      });

      expect(res.status).toBe(200);
      expect(existsSync(join(projectsRoot, "demo"))).toBe(true);
      await expect(webchatRepo.getProjectByPath("demo")).resolves.toMatchObject({
        path: "demo",
        archivedAt: null,
      });
    });

    it("creates project metadata after creating a folder", async () => {
      const res = await buildApp().request("/projects/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "projects/demo", type: "folder" }),
      });

      expect(res.status).toBe(200);
      expect(existsSync(join(projectsRoot, "demo"))).toBe(true);
      await expect(webchatRepo.getProjectByPath("demo")).resolves.toMatchObject({
        path: "demo",
        archivedAt: null,
      });
    });

    it("uploads a file into a project subdirectory", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      const formData = new FormData();
      formData.append("path", "projects/demo");
      formData.append("files", new File(["print('hi')"], "main.py", { type: "text/plain" }));

      const res = await buildApp().request("/projects/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        files: [{ path: "projects/demo/main.py", size: 11 }],
        message: "Uploaded 1 file",
        success: true,
      });
      expect(readFileSync(join(projectsRoot, "demo", "main.py"), "utf-8")).toBe("print('hi')");
    });

    it("accepts multiple files in a single upload", async () => {
      const formData = new FormData();
      formData.append("path", "projects");
      formData.append("files", new File(["a"], "a.txt"));
      formData.append("files", new File(["bb"], "b.txt"));

      const res = await buildApp().request("/projects/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        files: [
          { path: "projects/a.txt", size: 1 },
          { path: "projects/b.txt", size: 2 },
        ],
        message: "Uploaded 2 files",
        success: true,
      });
    });

    it("uploads folder contents with nested relative paths", async () => {
      const formData = new FormData();
      formData.append("path", "projects");
      formData.append("files", new File(["one"], "README.md", { type: "text/markdown" }));
      formData.append("paths", "demo/README.md");
      formData.append("files", new File(["two"], "index.ts", { type: "text/typescript" }));
      formData.append("paths", "demo/src/index.ts");

      const res = await buildApp().request("/projects/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        files: [
          { path: "projects/demo/README.md", size: 3 },
          { path: "projects/demo/src/index.ts", size: 3 },
        ],
        message: "Uploaded 2 files",
        success: true,
      });
      expect(readFileSync(join(projectsRoot, "demo", "README.md"), "utf-8")).toBe("one");
      expect(readFileSync(join(projectsRoot, "demo", "src", "index.ts"), "utf-8")).toBe("two");
    });

    it("rejects folder upload paths that escape the project root", async () => {
      const formData = new FormData();
      formData.append("path", "projects");
      formData.append("files", new File(["safe"], "safe.txt"));
      formData.append("paths", "demo/safe.txt");
      formData.append("files", new File(["x"], "x.txt"));
      formData.append("paths", "../x.txt");

      const res = await buildApp().request("/projects/file", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "Invalid file name" });
      expect(existsSync(join(projectsRoot, "demo", "safe.txt"))).toBe(false);
      expect(existsSync(join(projectsRoot, "x.txt"))).toBe(false);
    });

    it("rejects folder upload paths inside ignored project directories", async () => {
      for (const ignoredPath of ["demo/node_modules/pkg/index.js", "demo/.next/cache.bin"]) {
        const formData = new FormData();
        formData.append("path", "projects");
        formData.append("files", new File(["safe"], "safe.txt"));
        formData.append("paths", "demo/safe.txt");
        formData.append("files", new File(["ignored"], "ignored.bin"));
        formData.append("paths", ignoredPath);

        const res = await buildApp().request("/projects/file", {
          method: "POST",
          body: formData,
        });

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          error: "Ignored file paths cannot be uploaded",
        });
        expect(existsSync(join(projectsRoot, "demo", "safe.txt"))).toBe(false);
        expect(existsSync(join(projectsRoot, ignoredPath))).toBe(false);
      }
    });
  });

  describe("PATCH /projects/file", () => {
    it("renames project files", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "old.md"), "note");

      const res = await buildApp().request("/projects/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "projects/demo/old.md", name: "new.md" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Renamed file",
        path: "projects/demo/new.md",
        success: true,
      });
      expect(existsSync(join(projectsRoot, "demo", "old.md"))).toBe(false);
      expect(readFileSync(join(projectsRoot, "demo", "new.md"), "utf-8")).toBe("note");
    });

    it("renames project folders", async () => {
      mkdirSync(join(projectsRoot, "demo", "src"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "src", "index.ts"), "export {};\n");

      const res = await buildApp().request("/projects/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "projects/demo", name: "renamed" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Renamed folder",
        path: "projects/renamed",
        success: true,
      });
      expect(existsSync(join(projectsRoot, "demo"))).toBe(false);
      expect(readFileSync(join(projectsRoot, "renamed", "src", "index.ts"), "utf-8")).toBe(
        "export {};\n",
      );
    });

    it("moves project files into folders", async () => {
      mkdirSync(join(projectsRoot, "demo", "src"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "README.md"), "# Demo\n");

      const res = await buildApp().request("/projects/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "projects/demo/README.md",
          parentPath: "projects/demo/src",
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Moved file",
        path: "projects/demo/src/README.md",
        success: true,
      });
      expect(existsSync(join(projectsRoot, "demo", "README.md"))).toBe(false);
      expect(readFileSync(join(projectsRoot, "demo", "src", "README.md"), "utf-8")).toBe(
        "# Demo\n",
      );
    });

    it("rejects renaming the projects root", async () => {
      const res = await buildApp().request("/projects/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "projects", name: "renamed" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Cannot rename projects root",
      });
      expect(existsSync(projectsRoot)).toBe(true);
    });
  });

  describe("DELETE /projects/file", () => {
    it("deletes project files", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "README.md"), "# Demo\n");

      const res = await buildApp().request("/projects/file?path=projects/demo/README.md", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Deleted file",
        success: true,
      });
      expect(existsSync(join(projectsRoot, "demo", "README.md"))).toBe(false);
    });

    it("deletes project folders recursively", async () => {
      mkdirSync(join(projectsRoot, "demo", "src"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "src", "index.ts"), "export {};\n");

      const res = await buildApp().request("/projects/file?path=projects/demo", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        message: "Deleted folder",
        success: true,
      });
      expect(existsSync(join(projectsRoot, "demo"))).toBe(false);
    });

    it("removes deleted project folder metadata after cleanup", async () => {
      mkdirSync(join(projectsRoot, "demo", "nested"), { recursive: true });
      mkdirSync(join(projectsRoot, "demo-other"), { recursive: true });
      await webchatRepo.createProject("demo", "demo");
      await webchatRepo.createProject("nested", "demo/nested");
      await webchatRepo.createProject("demo-other", "demo-other");

      const res = await buildApp().request("/projects/file?path=projects/demo", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(existsSync(join(projectsRoot, "demo"))).toBe(false);
      await expect(webchatRepo.getProjectByPath("demo")).resolves.toBeNull();
      await expect(webchatRepo.getProjectByPath("demo/nested")).resolves.toBeNull();
      await expect(webchatRepo.getProjectRecordByPath("demo")).resolves.toBeNull();
      await expect(webchatRepo.getProjectRecordByPath("demo/nested")).resolves.toBeNull();
      await expect(webchatRepo.listProjectPaths()).resolves.toEqual(["default", "demo-other"]);
    });

    it("deletes chats under the deleted project folder", async () => {
      mkdirSync(join(projectsRoot, "demo", "nested"), { recursive: true });
      mkdirSync(join(projectsRoot, "demo-other"), { recursive: true });
      await webchatRepo.createProject("demo", "demo");
      await webchatRepo.createProject("nested", "demo/nested");
      await webchatRepo.createProject("demo-other", "demo-other");
      await webchatRepo.createSession("sess-demo", "Demo chat", undefined, "demo", null, "demo");
      await webchatRepo.createSession(
        "sess-demo-nested",
        "Nested chat",
        undefined,
        "nested",
        null,
        "demo/nested",
      );
      await webchatRepo.createSession(
        "sess-demo-child",
        "Demo child",
        undefined,
        "demo",
        null,
        "demo",
        "designer",
        "webchat_handoff",
      );
      await webchatRepo.createSession(
        "sess-demo-other",
        "Other chat",
        undefined,
        "demo-other",
        null,
        "demo-other",
      );
      await webchatRepo.addMessage("msg-demo", "sess-demo", "user", textMessage("demo"));
      await webchatRepo.addMessage(
        "msg-demo-nested",
        "sess-demo-nested",
        "user",
        textMessage("nested"),
      );
      await webchatRepo.addMessage(
        "msg-demo-child",
        "sess-demo-child",
        "assistant",
        textMessage("child"),
      );
      await webchatRepo.addMessage(
        "msg-demo-other",
        "sess-demo-other",
        "user",
        textMessage("other"),
      );
      await webchatRepo.createSharedChat({
        id: "share-demo",
        sessionId: "sess-demo",
        title: "Demo share",
        snapshot: "{}",
        layout: "[]",
        projectPath: "demo",
      });
      const closeMain = rs.fn(async () => undefined);
      const closeChild = rs.fn(async () => undefined);
      type LiveAgentSession = NonNullable<
        ReturnType<NonNullable<RouteDeps["agentSessionManager"]>["peek"]>
      >;
      const agentSessionManager: RouteDeps["agentSessionManager"] = {
        peek: ({ agentName, channelThreadKey }) => {
          if (agentName === "main" && channelThreadKey === "webchat:sess-demo") {
            return { close: closeMain } as unknown as LiveAgentSession;
          }
          if (agentName === "designer" && channelThreadKey === "webchat:sess-demo-child") {
            return { close: closeChild } as unknown as LiveAgentSession;
          }
          return undefined;
        },
      };

      const res = await buildApp({ agentSessionManager, settingsRepo, webchatRepo }).request(
        "/projects/file?path=projects/demo",
        { method: "DELETE" },
      );

      expect(res.status).toBe(200);
      expect(existsSync(join(projectsRoot, "demo"))).toBe(false);
      expect(closeMain).toHaveBeenCalledWith("user");
      expect(closeChild).toHaveBeenCalledWith("user");
      await expect(webchatRepo.getSession("sess-demo")).resolves.toBeNull();
      await expect(webchatRepo.getSession("sess-demo-nested")).resolves.toBeNull();
      await expect(webchatRepo.getSession("sess-demo-child")).resolves.toBeNull();
      await expect(webchatRepo.getSharedChat("share-demo")).resolves.toBeNull();
      await expect(webchatRepo.getSession("sess-demo-other")).resolves.toMatchObject({
        id: "sess-demo-other",
      });
      await expect(webchatRepo.getMessages("sess-demo-other")).resolves.toHaveLength(1);
      await expect(webchatRepo.listProjectPaths()).resolves.toEqual(["default", "demo-other"]);
    });

    it("recovers missing project cleanup after a post-delete cleanup failure", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      await webchatRepo.createProject("demo", "demo");
      await webchatRepo.createSession("sess-demo", "Demo chat", undefined, "demo", null, "demo");
      const cleanupError = new Error("cleanup failed");
      let failCleanup = true;
      const failingCleanupRepo: RouteDeps["webchatRepo"] = {
        getMessagesBatch: (sessionIds) => webchatRepo.getMessagesBatch(sessionIds),
        getProjectUsageTotals: (projectPath, options) =>
          webchatRepo.getProjectUsageTotals(projectPath, options),
        getUsageTotals: (options) => webchatRepo.getUsageTotals(options),
        archiveProjectsByPathPrefix: (projectPath, options) =>
          webchatRepo.archiveProjectsByPathPrefix(projectPath, options),
        deleteArchivedProjectsByPathPrefix: (projectPath) =>
          webchatRepo.deleteArchivedProjectsByPathPrefix(projectPath),
        deleteSessionsByProjectPathPrefix: async (projectPath) => {
          if (failCleanup) {
            failCleanup = false;
            throw cleanupError;
          }
          return webchatRepo.deleteSessionsByProjectPathPrefix(projectPath);
        },
        ensureProject: (projectPath, name, options) =>
          webchatRepo.ensureProject(projectPath, name, options),
        getProjectRecordByPath: (projectPath) => webchatRepo.getProjectRecordByPath(projectPath),
        listProjectPaths: () => webchatRepo.listProjectPaths(),
        listSessionRefsByProjectPathPrefix: (projectPath) =>
          webchatRepo.listSessionRefsByProjectPathPrefix(projectPath),
        listSessionsByProjectPath: (projectPath, options) =>
          webchatRepo.listSessionsByProjectPath(projectPath, options),
        listSessionsPage: (options) => webchatRepo.listSessionsPage(options),
        unarchiveProjectsByPaths: (projectPaths, options) =>
          webchatRepo.unarchiveProjectsByPaths(projectPaths, options),
      };

      const firstRes = await buildApp({ settingsRepo, webchatRepo: failingCleanupRepo }).request(
        "/projects/file?path=projects/demo",
        { method: "DELETE" },
      );

      expect(firstRes.status).toBe(500);
      expect(existsSync(join(projectsRoot, "demo"))).toBe(false);
      await expect(webchatRepo.getProjectRecordByPath("demo")).resolves.toMatchObject({
        path: "demo",
        archivedAt: expect.any(Date),
      });
      await expect(webchatRepo.getSession("sess-demo")).resolves.toMatchObject({ id: "sess-demo" });

      const retryRes = await buildApp({ settingsRepo, webchatRepo: failingCleanupRepo }).request(
        "/projects/file?path=projects/demo",
        { method: "DELETE" },
      );

      expect(retryRes.status).toBe(200);
      await expect(webchatRepo.getSession("sess-demo")).resolves.toBeNull();
      await expect(webchatRepo.getProjectRecordByPath("demo")).resolves.toBeNull();
    });

    it("rolls back project metadata when filesystem deletion fails", async () => {
      mkdirSync(join(projectsRoot, "demo"), { recursive: true });
      await webchatRepo.createProject("demo", "demo");
      await webchatRepo.createSession("sess-demo", "Demo chat", undefined, "demo", null, "demo");

      chmodSync(projectsRoot, 0o555);
      let res: Response;
      try {
        res = await buildApp().request("/projects/file?path=projects/demo", {
          method: "DELETE",
        });
      } finally {
        chmodSync(projectsRoot, 0o755);
      }

      expect(res.status).toBe(500);
      expect(existsSync(join(projectsRoot, "demo"))).toBe(true);
      await expect(webchatRepo.getProjectByPath("demo")).resolves.toMatchObject({
        path: "demo",
        archivedAt: null,
      });
      await expect(webchatRepo.getSession("sess-demo")).resolves.toMatchObject({ id: "sess-demo" });
    });

    it("keeps parent and file-path chats while deleting subfolder chats", async () => {
      mkdirSync(join(projectsRoot, "demo", "src"), { recursive: true });
      writeFileSync(join(projectsRoot, "demo", "note.txt"), "note");
      await webchatRepo.createProject("demo", "demo");
      await webchatRepo.createSession("sess-demo", "Demo chat", undefined, "demo", null, "demo");
      await webchatRepo.createSession("sess-src", "Src chat", undefined, "src", null, "demo/src");
      await webchatRepo.createSession(
        "sess-file-path",
        "File-path chat",
        undefined,
        "note.txt",
        null,
        "demo/note.txt",
      );
      await webchatRepo.addMessage("msg-demo", "sess-demo", "user", textMessage("demo"));
      await webchatRepo.addMessage("msg-src", "sess-src", "user", textMessage("src"));
      await webchatRepo.addMessage("msg-file-path", "sess-file-path", "user", textMessage("file"));

      const folderRes = await buildApp().request("/projects/file?path=projects/demo/src", {
        method: "DELETE",
      });
      const fileRes = await buildApp().request("/projects/file?path=projects/demo/note.txt", {
        method: "DELETE",
      });

      expect(folderRes.status).toBe(200);
      expect(fileRes.status).toBe(200);
      expect(existsSync(join(projectsRoot, "demo", "src"))).toBe(false);
      expect(existsSync(join(projectsRoot, "demo", "note.txt"))).toBe(false);
      await expect(webchatRepo.getSession("sess-demo")).resolves.toMatchObject({ id: "sess-demo" });
      await expect(webchatRepo.getSession("sess-src")).resolves.toBeNull();
      await expect(webchatRepo.getSession("sess-file-path")).resolves.toMatchObject({
        id: "sess-file-path",
      });
      await expect(webchatRepo.getMessages("sess-demo")).resolves.toHaveLength(1);
      await expect(webchatRepo.getMessages("sess-src")).resolves.toEqual([]);
      await expect(webchatRepo.getMessages("sess-file-path")).resolves.toHaveLength(1);
      await expect(webchatRepo.getProjectByPath("demo")).resolves.toMatchObject({ path: "demo" });
      await expect(webchatRepo.getProjectByPath("demo/src")).resolves.toBeNull();
    });

    it("rejects deleting the projects root", async () => {
      const res = await buildApp().request("/projects/file?path=projects", {
        method: "DELETE",
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Cannot delete projects root",
      });
      expect(existsSync(projectsRoot)).toBe(true);
    });
  });
});
