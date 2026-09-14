import { Hono } from "hono";
import type {
  ProjectDashboardChat,
  ProjectDashboardChatPage,
  ProjectDashboardChatsResponse,
  ProjectDashboardResolveResponse,
  ProjectDashboardResponse,
  ProjectDashboardUsageDay,
} from "@rome/api-types/projects";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join, normalize, resolve, sep } from "node:path";
import {
  createAssetHandler,
  createDownloadHandler,
  createFileDeleteHandler,
  createFileGetHandler,
  createFilePostHandler,
  createFilePutHandler,
  createFileRenameHandler,
  createFileWatchEventsHandler,
  createHistoryHandler,
  createResolveHandler,
  createSearchHandler,
  createTreeHandler,
  resolveNearestGitTarget,
  type FileBrowserScope,
} from "../../lib/file-browser-server.js";
import { ensureProjectsRootInitialized } from "../../paths.js";
import { parseTimeZone } from "../../lib/timezone.js";
import { resolveWebchatLargeModelSelection } from "../../core/model-selector.js";
import type { ApiDeps } from "../deps.js";

// Directories that must never surface as project roots (top-level entries
// under the projects root): build outputs and dependency trees are not
// projects, so they stay out of the "all projects" list.
const PROJECTS_ROOT_IGNORED_NAMES = [
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
];
// Directories skipped *inside* a project tree. `dist` is intentionally not in
// this list: a folder literally named `dist` is a legitimate, browsable part
// of a project, and hiding it makes the tree (and thus the editor) unusable.
const PROJECTS_TREE_IGNORED_NAMES = [".next", ".turbo", "build", "coverage", "node_modules"];
const PROJECT_DASHBOARD_DAYS = 14;
const PROJECT_DASHBOARD_CHAT_LIMIT = 20;
const PROJECT_DASHBOARD_MAX_CHAT_LIMIT = 100;
const GUARDIAN_TIMEZONE_SETTING_KEY = "guardianTimezone";

type ProjectsRouteDeps = {
  agentSessionManager?: Pick<ApiDeps["agentSessionManager"], "peek">;
  // Optional only because `ApiDeps.settingsRepo` is still optional and the
  // production callsite passes the full ApiDeps; when absent, dashboard
  // dates fall back to UTC.
  settingsRepo?: Pick<NonNullable<ApiDeps["settingsRepo"]>, "get">;
  webchatRepo: Pick<
    ApiDeps["webchatRepo"],
    | "getMessagesBatch"
    | "getProjectUsageTotals"
    | "getUsageTotals"
    | "archiveProjectsByPathPrefix"
    | "deleteArchivedProjectsByPathPrefix"
    | "deleteSessionsByProjectPathPrefix"
    | "ensureProject"
    | "getProjectRecordByPath"
    | "listProjectPaths"
    | "listSessionRefsByProjectPathPrefix"
    | "listSessionsByProjectPath"
    | "listSessionsPage"
    | "unarchiveProjectsByPaths"
  >;
};

interface CalendarDateParts {
  day: number;
  month: number;
  year: number;
}

type ProjectSession = Awaited<
  ReturnType<NonNullable<ProjectsRouteDeps["webchatRepo"]>["listSessionsByProjectPath"]>
>["sessions"][number];

type ProjectUsageTotals = Awaited<
  ReturnType<NonNullable<ProjectsRouteDeps["webchatRepo"]>["getProjectUsageTotals"]>
>;

interface PreparedProjectFolderDelete {
  archivedProjectPaths: string[];
  projectPath: string;
}

function isWithinDirectory(targetPath: string, directoryPath: string): boolean {
  const normalizedTarget = normalize(targetPath);
  const normalizedDirectory = normalize(directoryPath);
  return (
    normalizedTarget === normalizedDirectory ||
    normalizedTarget.startsWith(`${normalizedDirectory}${sep}`)
  );
}

function resolveProjectLogicalPath(
  logicalPath: string,
  rootDir: string,
  logicalRoot = "projects",
): { logicalPath: string; relativePath: string; resolvedPath: string } | null {
  if (logicalPath === logicalRoot) return null;
  if (!logicalPath.startsWith(`${logicalRoot}/`)) return null;

  const relativePath = logicalPath.slice(logicalRoot.length + 1);
  if (!relativePath) return null;

  const resolvedPath = resolve(rootDir, relativePath);
  if (!isWithinDirectory(resolvedPath, rootDir)) return null;
  return { logicalPath, relativePath, resolvedPath };
}

function resolveProjectsRootLogicalPath(
  logicalPath: string,
  rootDir: string,
  logicalRoot = "projects",
): { logicalPath: string; relativePath: string; resolvedPath: string } | null {
  return logicalPath === logicalRoot
    ? { logicalPath, relativePath: "", resolvedPath: rootDir }
    : null;
}

function normalizeProjectCandidatePath(projectPath: string): string | null {
  let trimmed = projectPath.trim();
  if (trimmed === "projects") return null;
  if (trimmed.startsWith("projects/")) {
    trimmed = trimmed.slice("projects/".length);
  }
  if (!trimmed) return null;
  if (trimmed.includes("\\") || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return null;
  }

  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
}

function isSameOrChildProjectPath(relativePath: string, projectPath: string): boolean {
  return relativePath === projectPath || relativePath.startsWith(`${projectPath}/`);
}

function shouldSkipProjectEntry(name: string): boolean {
  return name.startsWith(".") || PROJECTS_ROOT_IGNORED_NAMES.includes(name);
}

function listTopLevelShadowProjectPaths(rootDir: string): string[] {
  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !shouldSkipProjectEntry(entry.name))
    .map((entry) => entry.name);
}

function buildWebchatChannelThreadKey(sessionId: string, largeModelSelection: unknown): string {
  const modelSelection = resolveWebchatLargeModelSelection(largeModelSelection);
  return modelSelection
    ? `webchat:${sessionId}:large-model:${modelSelection.id}`
    : `webchat:${sessionId}`;
}

async function closeLiveProjectSessions(
  agentSessionManager: ProjectsRouteDeps["agentSessionManager"],
  sessions: Awaited<
    ReturnType<ProjectsRouteDeps["webchatRepo"]["listSessionRefsByProjectPathPrefix"]>
  >,
): Promise<void> {
  if (!agentSessionManager || sessions.length === 0) return;

  await Promise.all(
    sessions.map(async (session) => {
      const liveSession = agentSessionManager.peek({
        agentName: session.agentName ?? "main",
        channelThreadKey: buildWebchatChannelThreadKey(session.id, session.largeModelSelection),
      });
      if (liveSession) {
        await liveSession.close("user").catch(() => undefined);
      }
    }),
  );
}

function getPreparedProjectFolderDelete(value: unknown): PreparedProjectFolderDelete | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PreparedProjectFolderDelete>;
  if (typeof candidate.projectPath !== "string") return null;
  if (!Array.isArray(candidate.archivedProjectPaths)) return null;
  if (!candidate.archivedProjectPaths.every((path) => typeof path === "string")) return null;
  return {
    archivedProjectPaths: candidate.archivedProjectPaths,
    projectPath: candidate.projectPath,
  };
}

async function prepareProjectFolderDelete(
  deps: ProjectsRouteDeps,
  logicalPath: string,
  type: "directory" | "file",
): Promise<PreparedProjectFolderDelete | null> {
  if (type !== "directory") return null;
  const projectPath = normalizeProjectCandidatePath(logicalPath);
  if (!projectPath) return null;

  const [existingProject, sessions] = await Promise.all([
    deps.webchatRepo.getProjectRecordByPath(projectPath),
    deps.webchatRepo.listSessionRefsByProjectPathPrefix(projectPath),
  ]);
  if (!existingProject) {
    if (sessions.length > 0) {
      await deps.webchatRepo.ensureProject(projectPath, basename(projectPath));
    }
  }
  const archivedProjectPaths = await deps.webchatRepo.archiveProjectsByPathPrefix(projectPath);
  return { archivedProjectPaths, projectPath };
}

async function rollbackProjectFolderDelete(
  deps: ProjectsRouteDeps,
  prepared: unknown,
): Promise<void> {
  const projectDelete = getPreparedProjectFolderDelete(prepared);
  if (!projectDelete) return;
  await deps.webchatRepo.unarchiveProjectsByPaths(projectDelete.archivedProjectPaths);
}

async function finalizeProjectFolderDelete(
  deps: ProjectsRouteDeps,
  projectPath: string,
): Promise<void> {
  const sessions = await deps.webchatRepo.listSessionRefsByProjectPathPrefix(projectPath);
  await closeLiveProjectSessions(deps.agentSessionManager, sessions);
  await deps.webchatRepo.deleteSessionsByProjectPathPrefix(projectPath);
  await deps.webchatRepo.deleteArchivedProjectsByPathPrefix(projectPath);
}

async function recoverMissingProjectFolderDelete(
  deps: ProjectsRouteDeps,
  logicalPath: string,
): Promise<{ message: string } | null> {
  const projectPath = normalizeProjectCandidatePath(logicalPath);
  if (!projectPath) return null;
  const project = await deps.webchatRepo.getProjectRecordByPath(projectPath);
  if (!project?.archivedAt) return null;
  await finalizeProjectFolderDelete(deps, projectPath);
  return { message: "Deleted folder" };
}

async function reviveCreatedProjectFolder(
  deps: ProjectsRouteDeps,
  logicalPath: string,
  type: "file" | "folder",
): Promise<void> {
  if (type !== "folder") return;
  const projectPath = normalizeProjectCandidatePath(logicalPath);
  if (!projectPath) return;
  await deps.webchatRepo.ensureProject(projectPath, basename(projectPath));
}

async function listAvailableProjectPaths(
  webchatRepo: ProjectsRouteDeps["webchatRepo"],
  rootDir: string,
): Promise<string[]> {
  const projectPaths = new Set<string>();

  for (const projectPath of listTopLevelShadowProjectPaths(rootDir)) {
    projectPaths.add(projectPath);
  }

  for (const projectPath of await webchatRepo.listProjectPaths()) {
    const normalizedProjectPath = normalizeProjectCandidatePath(projectPath);
    if (!normalizedProjectPath) continue;

    const resolvedProjectPath = resolve(rootDir, normalizedProjectPath);
    if (isWithinDirectory(resolvedProjectPath, rootDir)) {
      projectPaths.add(normalizedProjectPath);
    }
  }

  return [...projectPaths].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

async function resolveDashboardProjectPath(
  logicalPath: string,
  rootDir: string,
  webchatRepo: ProjectsRouteDeps["webchatRepo"],
): Promise<{
  availableProjectPaths: string[];
  logicalPath: string;
  relativePath: string;
  resolvedPath: string;
} | null> {
  const requestedPath = resolveProjectLogicalPath(logicalPath, rootDir);
  if (!requestedPath) return null;

  const availableProjectPaths = await listAvailableProjectPaths(webchatRepo, rootDir);
  const matchedProjectPath = availableProjectPaths.find((projectPath) =>
    isSameOrChildProjectPath(requestedPath.relativePath, projectPath),
  );
  if (!matchedProjectPath) return null;

  const resolvedProjectPath = resolveProjectLogicalPath(`projects/${matchedProjectPath}`, rootDir);
  return resolvedProjectPath ? { ...resolvedProjectPath, availableProjectPaths } : null;
}

function normalizeSnippet(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 180);
}

function extractMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return typeof parsed === "string" ? parsed : content;

    return parsed
      .flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const contentValue = (block as { content?: unknown }).content;
        const textValue = (block as { text?: unknown }).text;
        if (typeof contentValue === "string") return [contentValue];
        if (typeof textValue === "string") return [textValue];
        return [];
      })
      .join("\n");
  } catch {
    return content;
  }
}

function normalizeSearchText(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

async function getProjectDashboardTimeZone(
  settingsRepo?: ProjectsRouteDeps["settingsRepo"],
): Promise<string | undefined> {
  return parseTimeZone(await settingsRepo?.get(GUARDIAN_TIMEZONE_SETTING_KEY)) ?? undefined;
}

function createCalendarDateReader(timeZone?: string): (date: Date) => CalendarDateParts {
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  };
  if (timeZone) {
    options.timeZone = timeZone;
  }
  const formatter = new Intl.DateTimeFormat("en-US", options);

  return (date: Date) => {
    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;

    return {
      day: Number(day),
      month: Number(month),
      year: Number(year),
    };
  };
}

function formatDayKey(parts: CalendarDateParts): string {
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDayKey(parts: CalendarDateParts, offsetDays: number): string {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays));
  return formatDayKey({
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  });
}

function createUsageDays(
  now = new Date(),
  readCalendarDate = createCalendarDateReader(),
): ProjectDashboardUsageDay[] {
  const days: ProjectDashboardUsageDay[] = [];
  const today = readCalendarDate(now);

  for (let index = PROJECT_DASHBOARD_DAYS - 1; index >= 0; index -= 1) {
    days.push({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      date: shiftDayKey(today, -index),
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  return days;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return asUtc - date.getTime();
}

function calendarDateToInstant(parts: CalendarDateParts, timeZone?: string): Date {
  if (!timeZone) {
    return new Date(parts.year, parts.month - 1, parts.day);
  }

  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  const firstInstant = new Date(utcGuess - firstOffset);
  const correctedOffset = getTimeZoneOffsetMs(firstInstant, timeZone);
  return new Date(utcGuess - correctedOffset);
}

function parseDayKey(dayKey: string): CalendarDateParts | null {
  const [year, month, day] = dayKey.split("-").map(Number);
  if (!year || !month || !day) return null;
  return { day, month, year };
}

function createUsageDayRanges(
  usage: ProjectDashboardUsageDay[],
  timeZone?: string,
): Array<{ date: string; end: Date; start: Date }> {
  return usage.flatMap((day) => {
    const parts = parseDayKey(day.date);
    if (!parts) return [];
    return [
      {
        date: day.date,
        end: calendarDateToInstant(
          {
            day: parts.day + 1,
            month: parts.month,
            year: parts.year,
          },
          timeZone,
        ),
        start: calendarDateToInstant(parts, timeZone),
      },
    ];
  });
}

function applyUsageTotals(usage: ProjectDashboardUsageDay[], totals: ProjectUsageTotals): void {
  const usageByDate = new Map(usage.map((day) => [day.date, day]));
  for (const row of totals.days) {
    const day = usageByDate.get(row.date);
    if (day) {
      day.inputTokens = row.inputTokens;
      day.outputTokens = row.outputTokens;
      day.cacheReadTokens = row.cacheReadTokens;
      day.cacheWriteTokens = row.cacheWriteTokens;
      day.costUsd = row.costUsd;
    }
  }
}

function createUsageStats(totals: ProjectUsageTotals, usage: ProjectDashboardUsageDay[]) {
  return {
    cacheHitRate: calculateCacheHitRate(
      totals.totalCacheReadTokens,
      totals.totalInputTokens,
      totals.totalCacheWriteTokens,
    ),
    monthCostUsd: totals.monthCostUsd,
    monthTokens: totals.monthTokens,
    totalCacheReadTokens: totals.totalCacheReadTokens,
    totalCacheWriteTokens: totals.totalCacheWriteTokens,
    totalCostUsd: totals.totalCostUsd,
    totalInputTokens: totals.totalInputTokens,
    totalTokens: totals.totalTokens,
    usage,
  };
}

function parsePageParam(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function getChatPageParams(query: (name: string) => string | undefined): {
  cursor?: string;
  limit: number;
} {
  const requestedLimit = Math.max(1, parsePageParam(query("limit"), PROJECT_DASHBOARD_CHAT_LIMIT));
  const cursor = query("cursor");
  return {
    cursor: cursor && cursor.trim() ? cursor : undefined,
    limit: Math.min(requestedLimit, PROJECT_DASHBOARD_MAX_CHAT_LIMIT),
  };
}

function createChatPage(
  total: number,
  nextCursor: string | null,
  limit: number,
): ProjectDashboardChatPage {
  return {
    hasMore: nextCursor != null,
    limit,
    nextCursor,
    total,
  };
}

async function buildProjectDashboardChats(
  webchatRepo: ProjectsRouteDeps["webchatRepo"],
  sessions: ProjectSession[],
): Promise<ProjectDashboardChat[]> {
  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((session) => session.id);
  const allMessages = await webchatRepo.getMessagesBatch(sessionIds);
  const messagesBySession = new Map<string, typeof allMessages>();
  for (const message of allMessages) {
    const messages = messagesBySession.get(message.sessionId) ?? [];
    messages.push(message);
    messagesBySession.set(message.sessionId, messages);
  }

  return sessions
    .map((session) => {
      const messages = messagesBySession.get(session.id) ?? [];
      const latestMessage = [...messages]
        .reverse()
        .find((message) => message.role === "user" || message.role === "assistant");
      const latestAssistantMessage = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");
      const updatedAt = latestMessage?.createdAt ?? session.createdAt;

      const searchText = messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => extractMessageText(message.content))
        .map(normalizeSearchText)
        .filter(Boolean)
        .join(" ");

      return {
        createdAt: session.createdAt.toISOString(),
        id: session.id,
        messageCount: session.messageCount,
        searchText,
        snippet: latestAssistantMessage
          ? normalizeSnippet(extractMessageText(latestAssistantMessage.content))
          : latestMessage
            ? normalizeSnippet(extractMessageText(latestMessage.content))
            : "",
        title: session.name,
        updatedAt: updatedAt.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

async function buildProjectUsageStats(
  webchatRepo: ProjectsRouteDeps["webchatRepo"],
  projectPath: string,
  timeZone?: string,
  now = new Date(),
): Promise<{
  cacheHitRate: number;
  monthCostUsd: number;
  monthTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalTokens: number;
  usage: ProjectDashboardUsageDay[];
}> {
  const readCalendarDate = createCalendarDateReader(timeZone);
  const usage = createUsageDays(now, readCalendarDate);
  const today = readCalendarDate(now);
  const monthStart = calendarDateToInstant(
    {
      day: 1,
      month: today.month,
      year: today.year,
    },
    timeZone,
  );
  const totals = await webchatRepo.getProjectUsageTotals(projectPath, {
    dayRanges: createUsageDayRanges(usage, timeZone),
    monthStart,
  });

  applyUsageTotals(usage, totals);

  return createUsageStats(totals, usage);
}

async function buildAllProjectsChatPage(
  webchatRepo: ProjectsRouteDeps["webchatRepo"],
  options: { cursor?: string; limit: number },
): Promise<{
  chats: ProjectDashboardChat[];
  page: ProjectDashboardChatPage;
}> {
  const sessionPage = await webchatRepo.listSessionsPage({
    cursor: options.cursor,
    limit: options.limit,
  });
  const chats = await buildProjectDashboardChats(webchatRepo, sessionPage.sessions);

  return {
    chats,
    page: createChatPage(sessionPage.total, sessionPage.nextCursor, options.limit),
  };
}

async function buildAllProjectsUsageStats(
  webchatRepo: ProjectsRouteDeps["webchatRepo"],
  timeZone?: string,
  now = new Date(),
) {
  const readCalendarDate = createCalendarDateReader(timeZone);
  const usage = createUsageDays(now, readCalendarDate);
  const today = readCalendarDate(now);
  const monthStart = calendarDateToInstant(
    {
      day: 1,
      month: today.month,
      year: today.year,
    },
    timeZone,
  );
  const totals = await webchatRepo.getUsageTotals({
    dayRanges: createUsageDayRanges(usage, timeZone),
    monthStart,
  });

  applyUsageTotals(usage, totals);

  return createUsageStats(totals, usage);
}

async function buildAllProjectsDashboard(
  webchatRepo: ProjectsRouteDeps["webchatRepo"],
  rootDir: string,
  options: { cursor?: string; limit: number },
  timeZone?: string,
): Promise<ProjectDashboardResponse> {
  const now = new Date();
  const [availableProjectPaths, chatPage, usageStats] = await Promise.all([
    listAvailableProjectPaths(webchatRepo, rootDir),
    buildAllProjectsChatPage(webchatRepo, options),
    buildAllProjectsUsageStats(webchatRepo, timeZone, now),
  ]);

  return {
    availableProjectPaths,
    chats: chatPage.chats,
    chatPage: chatPage.page,
    logicalPath: "projects",
    name: "All projects",
    relativePath: "",
    stats: {
      cacheHitRate: usageStats.cacheHitRate,
      chatCount: chatPage.page.total,
      monthBudgetUsd: null,
      monthCostUsd: usageStats.monthCostUsd,
      monthTokens: usageStats.monthTokens,
      totalCostUsd: usageStats.totalCostUsd,
      totalTokens: usageStats.totalTokens,
    },
    usage: usageStats.usage,
  };
}

function calculateCacheHitRate(cacheReadTokens = 0, inputTokens = 0, cacheWriteTokens = 0): number {
  const promptTokens = cacheReadTokens + inputTokens + cacheWriteTokens;
  return promptTokens > 0 ? cacheReadTokens / promptTokens : 0;
}

export function projectsFilesRoutes(deps: ProjectsRouteDeps): Hono {
  const app = new Hono();
  const projectsRoot = ensureProjectsRootInitialized();

  const baseScope: FileBrowserScope = {
    assetBasePath: "/api/projects/asset",
    ignoredNames: PROJECTS_TREE_IGNORED_NAMES,
    logicalRoot: "projects",
    rootDir: projectsRoot,
  };

  const fileScope: FileBrowserScope = {
    ...baseScope,
    afterCreate: ({ logicalPath, type }) => reviveCreatedProjectFolder(deps, logicalPath, type),
    afterDelete: async ({ logicalPath, prepared, type }) => {
      if (type !== "directory") return;
      const projectPath =
        getPreparedProjectFolderDelete(prepared)?.projectPath ??
        normalizeProjectCandidatePath(logicalPath);
      if (!projectPath) return;
      await finalizeProjectFolderDelete(deps, projectPath);
    },
    beforeDelete: ({ logicalPath, type }) => prepareProjectFolderDelete(deps, logicalPath, type),
    recoverMissingDelete: ({ logicalPath }) => recoverMissingProjectFolderDelete(deps, logicalPath),
    rollbackDelete: ({ prepared }) => rollbackProjectFolderDelete(deps, prepared),
    historyTarget: (resolvedPath) => resolveNearestGitTarget(projectsRoot, resolvedPath),
    saveCommitTarget: (resolvedPath, logicalPath) => {
      const target = resolveNearestGitTarget(projectsRoot, resolvedPath);
      if (!target) return null;
      const fileName = logicalPath.split("/").pop() || logicalPath;
      return { ...target, message: `projects: update ${fileName}` };
    },
  };

  app.get("/projects/events", createFileWatchEventsHandler(baseScope));
  app.get("/projects/tree", createTreeHandler(baseScope));
  app.get("/projects/resolve", createResolveHandler(baseScope));
  app.get("/projects/file", createFileGetHandler(fileScope));
  app.post("/projects/file", createFilePostHandler(fileScope));
  app.put("/projects/file", createFilePutHandler(fileScope));
  app.patch("/projects/file", createFileRenameHandler(fileScope));
  app.delete("/projects/file", createFileDeleteHandler(fileScope));
  app.get("/projects/asset", createAssetHandler(baseScope));
  app.get("/projects/asset/:fileName", createAssetHandler(baseScope));
  app.get("/projects/download", createDownloadHandler(baseScope));
  app.get("/projects/history", createHistoryHandler(fileScope));
  app.get(
    "/projects/search",
    createSearchHandler({
      ...baseScope,
      searchGlobs: [
        "!**/.git/**",
        "!**/.next/**",
        "!**/.turbo/**",
        "!**/build/**",
        "!**/coverage/**",
        "!**/dist/**",
        "!**/node_modules/**",
      ],
    }),
  );

  app.get("/projects/dashboard", async (c) => {
    const webchatRepo = deps.webchatRepo;

    const requestedPath = c.req.query("path") ?? "";
    const rootPath = resolveProjectsRootLogicalPath(requestedPath, projectsRoot);
    if (rootPath) {
      const { cursor, limit } = getChatPageParams(c.req.query.bind(c.req));
      return c.json(
        await buildAllProjectsDashboard(
          webchatRepo,
          projectsRoot,
          { cursor, limit },
          await getProjectDashboardTimeZone(deps.settingsRepo),
        ),
      );
    }

    if (!resolveProjectLogicalPath(requestedPath, projectsRoot)) {
      return c.json({ error: "Project path is required" }, 400);
    }

    const projectPath = await resolveDashboardProjectPath(requestedPath, projectsRoot, webchatRepo);
    if (!projectPath) {
      return c.json({ error: "Project not found" }, 404);
    }

    if (!existsSync(projectPath.resolvedPath)) {
      mkdirSync(projectPath.resolvedPath, { recursive: true });
    }
    const folderStats = existsSync(projectPath.resolvedPath)
      ? lstatSync(projectPath.resolvedPath)
      : null;
    if (!folderStats?.isDirectory()) {
      return c.json({ error: "Project folder not found" }, 404);
    }

    const { cursor, limit } = getChatPageParams(c.req.query.bind(c.req));
    const sessionPage = await webchatRepo.listSessionsByProjectPath(projectPath.relativePath, {
      cursor,
      limit,
    });

    const [chats, usageStats] = await Promise.all([
      buildProjectDashboardChats(webchatRepo, sessionPage.sessions),
      buildProjectUsageStats(
        webchatRepo,
        projectPath.relativePath,
        await getProjectDashboardTimeZone(deps.settingsRepo),
      ),
    ]);

    const response: ProjectDashboardResponse = {
      availableProjectPaths: projectPath.availableProjectPaths,
      chats,
      chatPage: createChatPage(sessionPage.total, sessionPage.nextCursor, limit),
      logicalPath: projectPath.logicalPath,
      name: basename(projectPath.relativePath),
      relativePath: projectPath.relativePath,
      stats: {
        cacheHitRate: usageStats.cacheHitRate,
        chatCount: sessionPage.total,
        monthBudgetUsd: null,
        monthCostUsd: usageStats.monthCostUsd,
        monthTokens: usageStats.monthTokens,
        totalCostUsd: usageStats.totalCostUsd,
        totalTokens: usageStats.totalTokens,
      },
      usage: usageStats.usage,
    };

    return c.json(response);
  });

  app.get("/projects/dashboard/resolve", async (c) => {
    const webchatRepo = deps.webchatRepo;

    const requestedPath = c.req.query("path") ?? "";
    if (!resolveProjectLogicalPath(requestedPath, projectsRoot)) {
      return c.json({ error: "Project path is required" }, 400);
    }

    const projectPath = await resolveDashboardProjectPath(requestedPath, projectsRoot, webchatRepo);
    if (!projectPath) {
      return c.json({ error: "Project not found" }, 404);
    }

    const response: ProjectDashboardResolveResponse = {
      logicalPath: projectPath.logicalPath,
      relativePath: projectPath.relativePath,
    };
    return c.json(response);
  });

  app.get("/projects/dashboard/chats", async (c) => {
    const webchatRepo = deps.webchatRepo;

    const requestedPath = c.req.query("path") ?? "";
    const rootPath = resolveProjectsRootLogicalPath(requestedPath, projectsRoot);
    if (rootPath) {
      const { cursor, limit } = getChatPageParams(c.req.query.bind(c.req));
      const chatPage = await buildAllProjectsChatPage(webchatRepo, {
        cursor,
        limit,
      });
      const response: ProjectDashboardChatsResponse = {
        chats: chatPage.chats,
        page: chatPage.page,
      };
      return c.json(response);
    }

    if (!resolveProjectLogicalPath(requestedPath, projectsRoot)) {
      return c.json({ error: "Project path is required" }, 400);
    }

    const projectPath = await resolveDashboardProjectPath(requestedPath, projectsRoot, webchatRepo);
    if (!projectPath) {
      return c.json({ error: "Project not found" }, 404);
    }

    if (!existsSync(projectPath.resolvedPath)) {
      mkdirSync(projectPath.resolvedPath, { recursive: true });
    }
    const folderStats = existsSync(projectPath.resolvedPath)
      ? lstatSync(projectPath.resolvedPath)
      : null;
    if (!folderStats?.isDirectory()) {
      return c.json({ error: "Project folder not found" }, 404);
    }

    const { cursor, limit } = getChatPageParams(c.req.query.bind(c.req));
    const sessionPage = await webchatRepo.listSessionsByProjectPath(projectPath.relativePath, {
      cursor,
      limit,
    });

    const chats = await buildProjectDashboardChats(webchatRepo, sessionPage.sessions);
    const response: ProjectDashboardChatsResponse = {
      chats,
      page: createChatPage(sessionPage.total, sessionPage.nextCursor, limit),
    };

    return c.json(response);
  });

  return app;
}
