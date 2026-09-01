import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create as tarCreate } from "tar";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionEngine } from "../actions/engine.js";
import { AgentLoader } from "../core/agent-loader.js";
import { createAgentSessionManager } from "../core/agent-session.js";
import { createAgentLifecycleDispatcher } from "../core/agent-lifecycle.js";
import { CapabilityDiscovery } from "../core/capability-discovery.js";
import { PromptBuilder } from "../core/prompt-builder.js";
import { createRomeMcpServer, type RomeMcpGroup, type RomeMcpServer } from "../core/mcp/server.js";
import { createModelResolver } from "../core/model-resolver.js";
import { SessionManager } from "../core/session-manager.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import {
  createAppLifecycleHarness,
  MockModelProvider,
  type AppLifecycleHarness,
} from "../test/helpers.js";
import type { ModelSessionParams } from "../core/agent-runner.js";
import type { AppstoreSource } from "./lockfile.js";
import { AppLifecycleService } from "./lifecycle-service.js";
import { appIdToPathSegment, packArtifact } from "./packaging/index.js";

const FIXTURES_AGENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
  "agents",
);

const ACTION_INDEX_SOURCE = `
export function createAction(config, deps) {
  return {
    config,
    inputSchema: { type: "object", properties: {} },
    execute: async (args) => ({
      status: "ok",
      data: {
        echoed: args,
        appId: deps?.appContext?.app?.id ?? null,
      },
    }),
  };
}
`;

function actionYaml(publicName: string): string {
  return [
    `name: ${publicName}`,
    "type: custom",
    "description: e2e test action",
    "complexity: simple",
    "speed: fast",
    "reliability: high",
    "sideEffects: read-only",
    "",
  ].join("\n");
}

interface DbFixtureOptions {
  tablePrefix: string;
  /** Override migration SQL; defaults to a single CREATE TABLE `<prefix>__widgets`. */
  sql?: string;
}

const DEFAULT_DRIZZLE_JOURNAL = JSON.stringify(
  {
    version: "7",
    dialect: "sqlite",
    entries: [{ idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true }],
  },
  null,
  2,
);

function defaultMigrationSql(tablePrefix: string): string {
  return `CREATE TABLE \`${tablePrefix}__widgets\` (\n\t\`id\` text PRIMARY KEY NOT NULL\n);\n`;
}

async function writeMigrationsFixture(appRoot: string, db: DbFixtureOptions): Promise<void> {
  const migrationsDir = join(appRoot, "db", "migrations");
  await mkdir(join(migrationsDir, "meta"), { recursive: true });
  await writeFile(
    join(migrationsDir, "0000_init.sql"),
    db.sql ?? defaultMigrationSql(db.tablePrefix),
    "utf-8",
  );
  await writeFile(join(migrationsDir, "meta", "_journal.json"), DEFAULT_DRIZZLE_JOURNAL, "utf-8");
}

interface BuildWorkspaceAppOptions {
  version?: string;
  db?: DbFixtureOptions;
  formatVersion?: 1 | 2;
  /** For App Store bundles: manifest id to publish when testing an identity mismatch. */
  manifestId?: string;
}

interface AppStoreBundle {
  bytes: Buffer;
  sha256: string;
  listingId: string;
  version: string;
}

interface WriteAppFixtureOptions {
  id: string;
  actionName: string;
  version: string;
  db?: DbFixtureOptions;
  formatVersion?: 1 | 2;
}

async function writeAppFixture(rootDir: string, opts: WriteAppFixtureOptions): Promise<void> {
  await mkdir(join(rootDir, "actions", opts.actionName), { recursive: true });
  const manifestLines = [
    `formatVersion: ${opts.formatVersion ?? 1}`,
    `id: ${JSON.stringify(opts.id)}`,
    `name: ${JSON.stringify(opts.id)}`,
    `version: ${opts.version}`,
    `description: e2e test fixture ${opts.id}`,
    "",
    "actions:",
    `  - actions/${opts.actionName}`,
    "",
  ];
  if (opts.db) {
    manifestLines.push(
      "db:",
      "  migrations: db/migrations",
      `  tablePrefix: ${opts.db.tablePrefix}`,
      "",
    );
    await writeMigrationsFixture(rootDir, opts.db);
  }
  await writeFile(join(rootDir, "app.yaml"), manifestLines.join("\n"), "utf-8");
  await writeFile(
    join(rootDir, "actions", opts.actionName, "action.yaml"),
    actionYaml(opts.actionName),
    "utf-8",
  );
  await writeFile(
    join(rootDir, "actions", opts.actionName, "index.ts"),
    ACTION_INDEX_SOURCE,
    "utf-8",
  );
}

async function buildAppStoreBundle(
  listingId: string,
  version: string,
  actionName: string,
  options: BuildWorkspaceAppOptions = {},
): Promise<AppStoreBundle> {
  const stageDir = mkdtempSync(join(tmpdir(), "rome-e2e-bundle-"));
  const rootName = "bundle-root";
  const rootDir = join(stageDir, rootName);
  await mkdir(rootDir, { recursive: true });
  await writeAppFixture(rootDir, {
    id: options.manifestId ?? listingId,
    actionName,
    version,
    db: options.db,
    formatVersion: options.formatVersion,
  });

  const chunks: Buffer[] = [];
  const stream = tarCreate({ gzip: true, cwd: stageDir }, [
    rootName,
  ]) as unknown as NodeJS.ReadableStream;
  await new Promise<void>((resolveStream, rejectStream) => {
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolveStream());
    stream.on("error", rejectStream);
  });
  const bytes = Buffer.concat(chunks);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, listingId, version };
}

/**
 * Build a workspace fixture and pack it into a sibling `<appId>.packed/`
 * directory; return the packed-artifact path for use as `source.path`.
 * The raw source workspace is left in place for assertions that peek at it.
 */
async function buildWorkspaceApp(
  parentDir: string,
  appId: string,
  actionName: string,
  options: BuildWorkspaceAppOptions = {},
): Promise<string> {
  const appRoot = join(parentDir, appId);
  await writeAppFixture(appRoot, {
    id: appId,
    actionName,
    version: options.version ?? "0.1.0",
    db: options.db,
    formatVersion: options.formatVersion,
  });
  const packedRoot = join(parentDir, `${appId}.packed`);
  const packed = await packArtifact(appRoot, packedRoot, { appId });
  return packed.outDir;
}

/** A scaffold-shaped source repo: app fixture plus a `src/` marker dir. */
async function buildSourceApp(
  parentDir: string,
  appId: string,
  actionName: string,
): Promise<string> {
  const rootDir = join(parentDir, appId);
  await writeAppFixture(rootDir, { id: appId, actionName, version: "0.1.0" });
  await mkdir(join(rootDir, "src"), { recursive: true });
  await writeFile(join(rootDir, "src", "index.ts"), "export {};\n", "utf-8");
  return rootDir;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface InstallResponseBody {
  appId: string;
  spec: { source: { mode: string; path?: string }; enabled: boolean };
  phase: string;
  error?: string;
}

/**
 * Install via POST /apps. `expectedAppId` is the manifest id the fixture was
 * built with; the daemon derives the appId from the source and must echo it.
 */
async function installWorkspace(
  harness: AppLifecycleHarness,
  expectedAppId: string,
  workspacePath: string,
  enabled?: boolean,
): Promise<InstallResponseBody> {
  const body: Record<string, unknown> = {
    source: { mode: "bundle", path: workspacePath },
  };
  if (enabled !== undefined) body.enabled = enabled;
  const res = await harness.fetch("/apps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as InstallResponseBody | { error: string };
  if (res.status !== 200) {
    throw new Error(`POST /apps failed (${res.status}): ${JSON.stringify(parsed)}`);
  }
  const installBody = parsed as InstallResponseBody;
  expect(installBody.appId).toBe(expectedAppId);
  return installBody;
}

async function installSource(
  harness: AppLifecycleHarness,
  expectedAppId: string,
  sourcePath: string,
): Promise<InstallResponseBody> {
  const res = await harness.fetch("/apps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: { mode: "source", path: sourcePath } }),
  });
  const parsed = (await res.json()) as InstallResponseBody | { error: string };
  if (res.status !== 200) {
    throw new Error(`POST /apps failed (${res.status}): ${JSON.stringify(parsed)}`);
  }
  const installBody = parsed as InstallResponseBody;
  expect(installBody.appId).toBe(expectedAppId);
  return installBody;
}

interface InstallAppstoreOptions {
  enabled?: boolean;
  /** Override the contentHash sent in the request body (default: computed sha256). */
  contentHashOverride?: string;
  /** Omit `contentHash` from the request body; daemon must resolve it from the registry. */
  omitContentHash?: boolean;
}

async function installAppstore(
  harness: AppLifecycleHarness,
  bundle: AppStoreBundle,
  options: InstallAppstoreOptions = {},
): Promise<{ status: number; body: InstallResponseBody }> {
  const source: AppstoreSource = options.omitContentHash
    ? {
        mode: "appstore",
        listingId: bundle.listingId,
        version: bundle.version,
      }
    : {
        mode: "appstore",
        listingId: bundle.listingId,
        version: bundle.version,
        contentHash: options.contentHashOverride ?? bundle.sha256,
      };
  const body: Record<string, unknown> = { source };
  if (options.enabled !== undefined) body.enabled = options.enabled;
  const res = await harness.fetch("/apps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as InstallResponseBody | { error: string };
  return { status: res.status, body: parsed as InstallResponseBody };
}

interface DeleteResponseBody {
  appId?: string;
  purged?: boolean;
  error?: string;
}

async function uninstall(
  harness: AppLifecycleHarness,
  appId: string,
  opts: { purge?: boolean } = {},
): Promise<{ status: number; body: DeleteResponseBody }> {
  const res = await harness.fetch(`/apps/${encodeURIComponent(appId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purge: opts.purge ?? false }),
  });
  return { status: res.status, body: (await res.json()) as DeleteResponseBody };
}

interface ListedCard {
  id: string;
  status: string;
  isEnabled: boolean;
  canUninstall: boolean;
}

async function listApps(harness: AppLifecycleHarness): Promise<ListedCard[]> {
  const res = await harness.fetch("/apps");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { apps: ListedCard[] };
  return body.apps;
}

// Section K helpers — live MCP visibility across in-session app install.
// Model sessions expose Rome actions/skills through a transport-agnostic MCP
// server. These tests use the same native server boundary a provider receives
// at openSession, leaving transport adapters to their own thin integration
// surface.

interface SkillFixtureOptions {
  /** Path-relative-to-the-app subdir under `skills/`. */
  dir: string;
  /** Frontmatter `name:` — what `list_skills` exposes. */
  publicName: string;
  description: string;
  tools?: string[];
}

async function writeAppWithSkillFixture(
  parentDir: string,
  appId: string,
  actionName: string,
  skill: SkillFixtureOptions,
): Promise<string> {
  const appRoot = join(parentDir, `${appId}.src`);
  await mkdir(join(appRoot, "actions", actionName), { recursive: true });
  await mkdir(join(appRoot, "skills", skill.dir), { recursive: true });

  const toolsLine = skill.tools ? `tools: [${skill.tools.join(", ")}]` : "tools: []";
  await writeFile(
    join(appRoot, "app.yaml"),
    [
      "formatVersion: 1",
      `id: ${appId}`,
      `name: ${appId}`,
      "version: 0.1.0",
      `description: section-K fixture ${appId}`,
      "",
      "actions:",
      `  - actions/${actionName}`,
      "",
      "skills:",
      `  - skills/${skill.dir}`,
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    join(appRoot, "actions", actionName, "action.yaml"),
    actionYaml(actionName),
    "utf-8",
  );
  await writeFile(join(appRoot, "actions", actionName, "index.ts"), ACTION_INDEX_SOURCE, "utf-8");
  await writeFile(
    join(appRoot, "skills", skill.dir, "SKILL.md"),
    [
      "---",
      `name: ${skill.publicName}`,
      `description: ${skill.description}`,
      toolsLine,
      "---",
      "",
      `# ${skill.publicName}`,
      "",
      skill.description,
      "",
    ].join("\n"),
    "utf-8",
  );
  const packedRoot = join(parentDir, `${appId}.packed`);
  const packed = await packArtifact(appRoot, packedRoot, { appId });
  return packed.outDir;
}

class McpSessionModelProvider extends MockModelProvider {
  readonly mcpServers: RomeMcpServer[] = [];

  override async openSession(params: ModelSessionParams) {
    const server = createRomeMcpServer({
      getActionCatalog: params.getActionCatalog,
      getSkillCatalog: params.getSkillCatalog,
      subagentTools: params.subagentTools,
      handback: params.handback,
      executeAction: params.executeAction,
      executeSubagent: params.executeSubagent,
      executeSubmitOutput: params.executeSubmitOutput,
    });
    this.mcpServers.push(server);
    return await super.openSession(params);
  }

  lastMcpServer(): RomeMcpServer {
    const server = this.mcpServers[this.mcpServers.length - 1];
    if (!server) throw new Error("no MCP server opened yet");
    return server;
  }
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callMcpTool(
  server: RomeMcpServer,
  group: RomeMcpGroup,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  return await server.callTool(group, name, args);
}

function parseMcpJson<T>(result: McpToolResult): T {
  expect(result.isError).not.toBe(true);
  const text = result.content[0]?.text;
  expect(text).toBeDefined();
  return JSON.parse(text) as T;
}

async function buildSessionManagerForHarness(harness: AppLifecycleHarness): Promise<{
  manager: ReturnType<typeof createAgentSessionManager>;
  provider: McpSessionModelProvider;
  agentName: string;
}> {
  const agentLoader = new AgentLoader();
  await agentLoader.loadAll(FIXTURES_AGENTS_DIR);
  const agentName = "test-all-actions";

  const sessionManager = new SessionManager(new SessionsRepository(harness.db));
  const promptBuilder = new PromptBuilder();
  const provider = new McpSessionModelProvider();
  const modelResolver = createModelResolver({
    providers: [provider],
    aiToolState: {
      get: () => ({
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      }),
      refresh: async () => ({
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      }),
    },
  });
  const actionEngine = new ActionEngine(
    harness.actionRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    { processRole: "worker" },
  );

  const manager = createAgentSessionManager({
    agentLoader,
    sessionManager,
    promptBuilder,
    actionRegistry: harness.actionRegistry,
    modelResolver,
    actionEngine,
    skillCatalog: harness.skillCatalog,
    capabilityDiscovery: new CapabilityDiscovery(),
    lifecycleDispatcher: createAgentLifecycleDispatcher(),
  });

  return { manager, provider, agentName };
}

function sqliteHasTable(harness: AppLifecycleHarness, name: string): boolean {
  const row = (
    harness.db as unknown as {
      $client: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } };
    }
  ).$client
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return row != null;
}

describe("App lifecycle e2e", () => {
  let harness: AppLifecycleHarness;
  let workspaceParent: string;
  const bundleRegistry = new Map<string, Buffer>();
  // Section L wires this map into the harness as the RomeCloudListingClient stub.
  // Keyed by AppstoreSource.listingId; value is the version Rome Cloud "advertises".
  const romeCloudHighestVersions = new Map<string, string>();
  // Rome Cloud's authoritative contentHash for (listingId, version). The
  // installer reads this when an appstore source omits `contentHash`.
  const romeCloudContentHashes = new Map<string, string>();

  function bundleKey(source: { listingId: string; version: string }): string {
    return `${source.listingId}@${source.version}`;
  }

  beforeEach(async () => {
    bundleRegistry.clear();
    romeCloudHighestVersions.clear();
    romeCloudContentHashes.clear();
    harness = await createAppLifecycleHarness({
      bundleFetcher: async (source) => {
        const bytes = bundleRegistry.get(bundleKey(source));
        if (!bytes) {
          throw new Error(`bundleFetcher: no fixture registered for ${bundleKey(source)}`);
        }
        return bytes;
      },
      romeCloudListings: {
        async getHighestVersion(listingId) {
          return romeCloudHighestVersions.get(listingId) ?? null;
        },
        async getContentHash(listingId, version) {
          return romeCloudContentHashes.get(`${listingId}@${version}`) ?? null;
        },
      },
    });
    workspaceParent = join(harness.profileRoot, "workspaces");
    await mkdir(workspaceParent, { recursive: true });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe("A. Single-app lifecycle", () => {
    it("POST installs the app, returns the manifest-derived appId, and it surfaces in GET /apps as active", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "alpha", "echo_alpha");
      const body = await installWorkspace(harness, "alpha", appRoot);
      expect(body.appId).toBe("alpha");
      expect(body.phase).toBe("installed");
      expect(body.spec.enabled).toBe(true);

      const cards = await listApps(harness);
      const card = cards.find((c) => c.id === "alpha");
      expect(card).toBeDefined();
      expect(card?.status).toBe("active");
    });

    it("GET /apps ranks source-installed apps before other installs", async () => {
      const firstBundle = await buildWorkspaceApp(workspaceParent, "bundle-first", "echo_bundle_1");
      await installWorkspace(harness, "bundle-first", firstBundle);

      const firstSource = await buildSourceApp(workspaceParent, "source-first", "echo_source_1");
      await installSource(harness, "source-first", firstSource);

      const secondBundle = await buildWorkspaceApp(
        workspaceParent,
        "bundle-second",
        "echo_bundle_2",
      );
      await installWorkspace(harness, "bundle-second", secondBundle);

      const secondSource = await buildSourceApp(workspaceParent, "source-second", "echo_source_2");
      await installSource(harness, "source-second", secondSource);

      const ids = (await listApps(harness)).map((card) => card.id);
      expect(
        ids.filter((id) =>
          ["bundle-first", "source-first", "bundle-second", "source-second"].includes(id),
        ),
      ).toEqual(["source-first", "source-second", "bundle-first", "bundle-second"]);
    });

    it("after install, the app's action is invocable and receives appContext", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "beta", "echo_beta");
      await installWorkspace(harness, "beta", appRoot);
      await waitFor(() => harness.hasAction("echo_beta"));
      const result = await harness.invokeAction("echo_beta", { ping: 1 });
      expect(result).toMatchObject({
        status: "ok",
        data: { echoed: { ping: 1 }, appId: "beta" },
      });
    });

    it("DELETE removes the app from GET /apps and the action becomes unreachable", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "gamma", "echo_gamma");
      await installWorkspace(harness, "gamma", appRoot);
      await waitFor(() => harness.hasAction("echo_gamma"));

      const { status, body } = await uninstall(harness, "gamma");
      expect(status).toBe(200);
      expect(body).toEqual({ appId: "gamma", purged: false });

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "gamma")).toBeUndefined();
      expect(harness.hasAction("echo_gamma")).toBe(false);

      const getRes = await harness.fetch("/apps/gamma");
      expect(getRes.status).toBe(404);
    });

    it("install → uninstall → install loop converges back to invocable action", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "delta", "echo_delta");
      await installWorkspace(harness, "delta", appRoot);
      await waitFor(() => harness.hasAction("echo_delta"));
      await uninstall(harness, "delta");
      expect(harness.hasAction("echo_delta")).toBe(false);

      await installWorkspace(harness, "delta", appRoot);
      await waitFor(() => harness.hasAction("echo_delta"));
      const result = await harness.invokeAction("echo_delta", { round: 2 });
      expect(result).toMatchObject({ data: { echoed: { round: 2 }, appId: "delta" } });
    });

    it("db-declaring app: install creates the prefixed table before phase=installed", async () => {
      const tablePrefix = "ze2e_pos";
      const appRoot = await buildWorkspaceApp(workspaceParent, "dbapp-pos", "echo_db_pos", {
        db: { tablePrefix },
      });
      const body = await installWorkspace(harness, "dbapp-pos", appRoot);
      expect(body.phase).toBe("installed");

      expect(sqliteHasTable(harness, `${tablePrefix}__widgets`)).toBe(true);
      // Drizzle's migrations-tracking table is named via appMigrationsTableName.
      expect(sqliteHasTable(harness, `__drizzle_migrations_app_${tablePrefix}`)).toBe(true);
    });

    it("db-declaring app: broken migration SQL surfaces the failure via GET /apps/:id", async () => {
      const tablePrefix = "ze2e_neg";
      const appRoot = await buildWorkspaceApp(workspaceParent, "dbapp-neg", "echo_db_neg", {
        db: { tablePrefix, sql: "CREATE TABLE WHERE invalid syntax;" },
      });
      await installWorkspace(harness, "dbapp-neg", appRoot);

      // Catalog stays "installed" — installer doesn't gate on migration failure,
      // so the only observable is the missing table.
      expect(sqliteHasTable(harness, `${tablePrefix}__widgets`)).toBe(false);
    });
  });

  describe("B. Idempotency", () => {
    it("re-installing the same source returns 200 and keeps a single entry", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "epsilon", "echo_eps");
      await installWorkspace(harness, "epsilon", appRoot);
      await installWorkspace(harness, "epsilon", appRoot);
      const cards = await listApps(harness);
      expect(cards.filter((c) => c.id === "epsilon")).toHaveLength(1);
      expect(cards.find((c) => c.id === "epsilon")?.status).toBe("active");
    });

    it("DELETE on a never-installed app returns 200 (idempotent uninstall)", async () => {
      const { status, body } = await uninstall(harness, "ghost-app");
      expect(status).toBe(200);
      expect(body).toEqual({ appId: "ghost-app", purged: false });
    });

    it("DELETE twice on the same app both return 200", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "zeta", "echo_zeta");
      await installWorkspace(harness, "zeta", appRoot);
      await waitFor(() => harness.hasAction("echo_zeta"));

      const first = await uninstall(harness, "zeta");
      const second = await uninstall(harness, "zeta");
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it("DELETE on a first-party app returns 400 and the app stays installed and invocable", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "fp-app", "echo_fp");
      // First-party apps are only ever installed by boot, which passes
      // firstParty: true — mirror that install here.
      const result = await harness.appManager.install({
        source: { mode: "bundle", path: appRoot },
        firstParty: true,
      });
      expect(result.state).toBe("installed");
      await waitFor(() => harness.hasAction("echo_fp"));

      const { status, body } = await uninstall(harness, "fp-app", { purge: true });
      expect(status).toBe(400);
      expect(body.error).toMatch(/cannot be uninstalled/i);

      const card = (await listApps(harness)).find((c) => c.id === "fp-app");
      expect(card?.status).toBe("active");
      expect(card?.canUninstall).toBe(false);
      expect(harness.hasAction("echo_fp")).toBe(true);
    });

    it("POST /apps with a bundle reusing a first-party app's id returns 400 and the app is unchanged", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "fp-locked", "echo_fp_locked");
      const bootInstalled = await harness.appManager.install({
        source: { mode: "bundle", path: appRoot },
        firstParty: true,
      });
      expect(bootInstalled.state).toBe("installed");
      await waitFor(() => harness.hasAction("echo_fp_locked"));

      // A different source tree whose manifest reuses the shipped app's id.
      const impostorRoot = await buildWorkspaceApp(
        join(workspaceParent, "impostor"),
        "fp-locked",
        "echo_impostor",
      );
      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { mode: "bundle", path: impostorRoot } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/cannot be replaced/i);

      expect(harness.hasAction("echo_fp_locked")).toBe(true);
      expect(harness.hasAction("echo_impostor")).toBe(false);
      const entry = await harness.appManager.readLockfileEntry("fp-locked");
      expect(entry?.installedHash).toBe(bootInstalled.installedHash);
    });
  });

  describe("C. Purge", () => {
    it("DELETE with purge=true drops app DB tables and the data dir", async () => {
      const tablePrefix = "zpurge";
      const appRoot = await buildWorkspaceApp(workspaceParent, "purge-app", "echo_purge", {
        db: { tablePrefix },
      });
      await installWorkspace(harness, "purge-app", appRoot);
      await waitFor(() => harness.hasAction("echo_purge"));

      expect(sqliteHasTable(harness, `${tablePrefix}__widgets`)).toBe(true);

      const dataDir = join(harness.appsRoot, "data", "purge-app");
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "marker"), "data", "utf-8");

      const { status, body } = await uninstall(harness, "purge-app", { purge: true });
      expect(status).toBe(200);
      expect(body).toEqual({ appId: "purge-app", purged: true });

      expect(sqliteHasTable(harness, `${tablePrefix}__widgets`)).toBe(false);
      expect(sqliteHasTable(harness, `__drizzle_migrations_app_${tablePrefix}`)).toBe(false);
      expect(existsSync(dataDir)).toBe(false);
    });

    it("DELETE without purge preserves DB tables and the data dir", async () => {
      const tablePrefix = "zkeep";
      const appRoot = await buildWorkspaceApp(workspaceParent, "keep-app", "echo_keep", {
        db: { tablePrefix },
      });
      await installWorkspace(harness, "keep-app", appRoot);
      await waitFor(() => harness.hasAction("echo_keep"));

      const dataDir = join(harness.appsRoot, "data", "keep-app");
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "marker"), "data", "utf-8");

      const { status, body } = await uninstall(harness, "keep-app", { purge: false });
      expect(status).toBe(200);
      expect(body).toEqual({ appId: "keep-app", purged: false });

      expect(sqliteHasTable(harness, `${tablePrefix}__widgets`)).toBe(true);
      expect(existsSync(join(dataDir, "marker"))).toBe(true);
    });
  });

  describe("D. Restart persistence", () => {
    it("an install survives daemon restart", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "persist", "echo_persist");
      await installWorkspace(harness, "persist", appRoot);
      await waitFor(() => harness.hasAction("echo_persist"));

      await harness.restart();
      await waitFor(() => harness.hasAction("echo_persist"));

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "persist")?.status).toBe("active");
      const result = await harness.invokeAction("echo_persist", { after: "restart" });
      expect(result).toMatchObject({ status: "ok" });
    });

    it("an uninstall survives daemon restart (app stays gone)", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "vanish", "echo_vanish");
      await installWorkspace(harness, "vanish", appRoot);
      await waitFor(() => harness.hasAction("echo_vanish"));
      await uninstall(harness, "vanish");

      await harness.restart();

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "vanish")).toBeUndefined();
      expect(harness.hasAction("echo_vanish")).toBe(false);
    });
  });

  describe("E. Failure recovery", () => {
    it("install with a non-existent bundle path is rejected with 422 and records nothing", async () => {
      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { mode: "bundle", path: join(workspaceParent, "does-not-exist") },
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/does not exist.*mode: "source"/s);

      // The rejected request leaves no trace — the app id is still free.
      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "bogus-app")).toBeUndefined();

      const goodRoot = await buildWorkspaceApp(workspaceParent, "bogus-app", "echo_recovered");
      await installWorkspace(harness, "bogus-app", goodRoot);
      await waitFor(() => harness.hasAction("echo_recovered"));
      const cardsAfter = await listApps(harness);
      expect(cardsAfter.find((c) => c.id === "bogus-app")?.status).toBe("active");
    });

    it("install rejects a bundle source that isn't a packed artifact", async () => {
      const rawDir = join(workspaceParent, "raw-not-packed");
      await mkdir(rawDir, { recursive: true });
      await writeFile(join(rawDir, "src.ts"), "// not packed\n", "utf-8");

      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { mode: "bundle", path: rawDir },
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/not a packed app artifact.*mode: "source"/s);

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "raw-app")).toBeUndefined();
    });

    it("a rejected re-install leaves the healthy installed app running", async () => {
      const goodRoot = await buildWorkspaceApp(workspaceParent, "sturdy", "echo_sturdy");
      await installWorkspace(harness, "sturdy", goodRoot);
      await waitFor(() => harness.hasAction("echo_sturdy"));

      // An app.yaml whose declared action was never produced — an unbuilt target.
      const unbuiltDir = join(workspaceParent, "sturdy-unbuilt");
      await mkdir(unbuiltDir, { recursive: true });
      await writeFile(
        join(unbuiltDir, "app.yaml"),
        [
          "formatVersion: 1",
          "id: sturdy",
          "version: 0.2.0",
          "description: unbuilt",
          "actions:",
          "  - actions/echo_sturdy",
          "",
        ].join("\n"),
        "utf-8",
      );

      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { mode: "bundle", path: unbuiltDir } }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/not a recognizably packed artifact/);

      // The prior install is untouched: still active, action still invocable.
      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "sturdy")?.status).toBe("active");
      const result = await harness.invokeAction("echo_sturdy", { after: "rejected reinstall" });
      expect(result).toMatchObject({ status: "ok" });
    });
  });

  describe("F. Multi-app independence", () => {
    it("installing A then B then uninstalling A leaves B's action invocable", async () => {
      const aRoot = await buildWorkspaceApp(workspaceParent, "multi-a", "echo_multi_a");
      const bRoot = await buildWorkspaceApp(workspaceParent, "multi-b", "echo_multi_b");
      await installWorkspace(harness, "multi-a", aRoot);
      await waitFor(() => harness.hasAction("echo_multi_a"));
      await installWorkspace(harness, "multi-b", bRoot);
      await waitFor(() => harness.hasAction("echo_multi_b"));

      await uninstall(harness, "multi-a");

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "multi-a")).toBeUndefined();
      expect(cards.find((c) => c.id === "multi-b")?.status).toBe("active");
      expect(harness.hasAction("echo_multi_a")).toBe(false);
      const result = await harness.invokeAction("echo_multi_b");
      expect(result).toMatchObject({ status: "ok", data: { appId: "multi-b" } });
    });
  });

  describe("G. Enable/disable toggle", () => {
    it("install disabled keeps the action unregistered; flipping enabled true via PATCH registers it", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "toggle", "echo_toggle");
      await installWorkspace(harness, "toggle", appRoot, false);

      const cardsDisabled = await listApps(harness);
      const disabledCard = cardsDisabled.find((c) => c.id === "toggle");
      expect(disabledCard?.status).not.toBe("active");
      expect(harness.hasAction("echo_toggle")).toBe(false);

      const patchRes = await harness.fetch("/apps/toggle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as InstallResponseBody;
      expect(patchBody.spec.enabled).toBe(true);
      expect(patchBody.spec.source.mode).toBe("bundle");
      expect(patchBody.spec.source.path).toBe(appRoot);

      await waitFor(() => harness.hasAction("echo_toggle"));
      const result = await harness.invokeAction("echo_toggle", { state: "enabled" });
      expect(result).toMatchObject({ data: { echoed: { state: "enabled" } } });
    });

    it("PATCH with missing/invalid body returns 400; PATCH on a never-installed app returns 404", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "patch-validate", "echo_patch");
      await installWorkspace(harness, "patch-validate", appRoot);

      const missingBody = await harness.fetch("/apps/patch-validate", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missingBody.status).toBe(400);
      expect(((await missingBody.json()) as { error: string }).error).toMatch(/enabled/);

      const badType = await harness.fetch("/apps/patch-validate", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "yes" }),
      });
      expect(badType.status).toBe(400);
      expect(((await badType.json()) as { error: string }).error).toMatch(/must be a boolean/);

      const unknownField = await harness.fetch("/apps/patch-validate", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          source: { mode: "bundle", path: "/tmp/anywhere" },
        }),
      });
      expect(unknownField.status).toBe(400);
      expect(((await unknownField.json()) as { error: string }).error).toMatch(
        /unknown fields: source/,
      );

      const notInstalled = await harness.fetch("/apps/no-such-app", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(notInstalled.status).toBe(404);
    });
  });

  describe("H. Boundary validation on POST/DELETE", () => {
    it("POST with no body source returns 400 — even when a lockfile entry exists", async () => {
      // First install — establishes a lockfile entry; the daemon must still
      // refuse to infer the source from it.
      const appRoot = await buildWorkspaceApp(workspaceParent, "src-required", "echo_src_required");
      await installWorkspace(harness, "src-required", appRoot);

      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/body\.source is required/);
    });

    it("POST with non-boolean enabled returns 400", async () => {
      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { mode: "bundle", path: workspaceParent },
          enabled: 1,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/enabled must be a boolean/);
    });

    it("POST with a null body returns 400", async () => {
      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/expected JSON object/);
    });

    it("POST re-installs (upgrades) the system app", async () => {
      const v1Parent = join(workspaceParent, "sys-v1");
      const v2Parent = join(workspaceParent, "sys-v2");
      await mkdir(v1Parent, { recursive: true });
      await mkdir(v2Parent, { recursive: true });

      const v1 = await buildWorkspaceApp(v1Parent, "system", "echo_sys", {
        version: "0.1.0",
      });
      const installed = await installWorkspace(harness, "system", v1);
      expect(installed.phase).toBe("installed");

      const v2 = await buildWorkspaceApp(v2Parent, "system", "echo_sys", {
        version: "0.2.0",
      });
      const upgraded = await installWorkspace(harness, "system", v2);
      expect(upgraded.phase).toBe("installed");

      const detail = await harness.fetch("/apps/system");
      const body = (await detail.json()) as InstallResponseBody;
      expect(body.spec.enabled).toBe(true);
    });

    it("POST a system-manifest source with enabled:false is rejected (system stays enabled)", async () => {
      const sysRoot = await buildWorkspaceApp(workspaceParent, "system", "echo_sys", {
        version: "0.1.0",
      });
      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { mode: "bundle", path: sysRoot }, enabled: false }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/cannot be disabled/);
    });

    it("DELETE /apps/system returns 400 SYSTEM_PROTECTED", async () => {
      const res = await harness.fetch("/apps/system", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purge: false }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/SYSTEM_PROTECTED/);
    });

    it("accepts a scoped app id whose slug uses the scoped listing grammar", async () => {
      const bundle = await buildAppStoreBundle("@handle/2048_game", "1.0.0", "echo_2048_game");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);

      const { status, body } = await installAppstore(harness, bundle);
      expect(status).toBe(200);
      expect(body.appId).toBe("@handle/2048_game");
      expect(body.phase).toBe("installed");
    });

    it("POST an appstore listingId that is not a listing id at all returns 400 and records nothing", async () => {
      // URL-shaped garbage must be rejected at the gate — it must not have a
      // slug sliced out of it and recorded as a failed install under that id.
      for (const listingId of ["javascript://not-a-bundle-path", "@handle", "Not A Slug"]) {
        const res = await harness.fetch("/apps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: { mode: "appstore", listingId, version: "1.0.0" },
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/not a valid listing id/);
      }
      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "not-a-bundle-path")).toBeUndefined();
    });
  });

  describe("I. Read endpoints", () => {
    it("GET /apps/:id returns spec + phase after install", async () => {
      const appRoot = await buildWorkspaceApp(workspaceParent, "read-app", "echo_read");
      await installWorkspace(harness, "read-app", appRoot);

      const res = await harness.fetch("/apps/read-app");
      expect(res.status).toBe(200);
      const body = (await res.json()) as InstallResponseBody;
      expect(body.spec.source).toEqual({ mode: "bundle", path: appRoot });
      expect(body.spec.enabled).toBe(true);
      expect(body.phase).toBe("installed");
    });

    it("GET /apps/:id returns 404 for an uninstalled app", async () => {
      const res = await harness.fetch("/apps/no-such-app");
      expect(res.status).toBe(404);
    });
  });

  describe("J. App-store mode", () => {
    it("POST with mode=appstore installs the bundle under the canonical listing id and surfaces it as active", async () => {
      const bundle = await buildAppStoreBundle("alpha-as", "1.0.0", "echo_alpha_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);

      const { status, body } = await installAppstore(harness, bundle);
      expect(status).toBe(200);
      expect(body.appId).toBe("alpha-as");
      expect(body.phase).toBe("installed");
      expect(body.spec.source).toMatchObject({
        mode: "appstore",
        listingId: "alpha-as",
        version: "1.0.0",
      });

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "alpha-as")?.status).toBe("active");
    });

    it("keeps scoped ids and their same-named artifacts isolated end to end", async () => {
      const fooId = "@foo/bar";
      const quxId = "@qux/bar";
      const foo = await buildAppStoreBundle(fooId, "1.0.0", "baz", {
        formatVersion: 2,
      });
      const qux = await buildAppStoreBundle(quxId, "1.0.0", "baz", {
        formatVersion: 2,
      });
      bundleRegistry.set(bundleKey(foo), foo.bytes);
      bundleRegistry.set(bundleKey(qux), qux.bytes);

      const fooInstall = await installAppstore(harness, foo);
      const quxInstall = await installAppstore(harness, qux);
      expect(fooInstall.status).toBe(200);
      expect(quxInstall.status).toBe(200);
      expect(fooInstall.body.appId).toBe(fooId);
      expect(quxInstall.body.appId).toBe(quxId);
      expect([...harness.actionLoader.getAllRecords().keys()]).toEqual(
        expect.arrayContaining(["@foo/bar:baz", "@qux/bar:baz"]),
      );
      expect(harness.hasAction("@foo/bar:baz")).toBe(true);
      expect(harness.hasAction("@qux/bar:baz")).toBe(true);

      const fooResult = await harness.invokeAction("@foo/bar:baz", { owner: "foo" });
      const quxResult = await harness.invokeAction("@qux/bar:baz", { owner: "qux" });
      expect(fooResult).toMatchObject({ data: { appId: fooId } });
      expect(quxResult).toMatchObject({ data: { appId: quxId } });

      const lockfile = JSON.parse(await readFile(harness.lockfilePath, "utf-8")) as {
        apps: Record<string, unknown>;
      };
      expect(Object.keys(lockfile.apps)).toEqual(expect.arrayContaining([fooId, quxId]));
      expect(existsSync(join(harness.installedRoot, appIdToPathSegment(fooId), "active"))).toBe(
        true,
      );
      expect(existsSync(join(harness.installedRoot, appIdToPathSegment(quxId), "active"))).toBe(
        true,
      );
      expect(existsSync(join(harness.installedRoot, "@foo", "bar"))).toBe(false);

      await harness.restart();
      expect(harness.hasAction("@foo/bar:baz")).toBe(true);
      expect(harness.hasAction("@qux/bar:baz")).toBe(true);

      const detail = await harness.fetch(`/apps/${encodeURIComponent(fooId)}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ spec: { source: { listingId: fooId } } });

      const removed = await uninstall(harness, fooId);
      expect(removed.status).toBe(200);
      expect(harness.hasAction("@foo/bar:baz")).toBe(false);
      expect(harness.hasAction("@qux/bar:baz")).toBe(true);
    });

    it("rejects a bundle whose manifest id disagrees with the listing id — 422, prior state untouched", async () => {
      // v1 installs cleanly: bundle manifest id matches the listing id.
      const good = await buildAppStoreBundle("twofaced-as", "1.0.0", "echo_twofaced_as");
      bundleRegistry.set(bundleKey(good), good.bytes);
      const first = await installAppstore(harness, good);
      expect(first.status).toBe(200);
      await waitFor(() => harness.hasAction("echo_twofaced_as"));

      // v2's published bundle carries a different manifest id than the listing —
      // the registry listing and the published bundle disagree.
      const bad = await buildAppStoreBundle("twofaced-as", "2.0.0", "echo_other_as", {
        manifestId: "other-app",
      });
      bundleRegistry.set(bundleKey(bad), bad.bytes);
      const { status, body } = await installAppstore(harness, bad);
      expect(status).toBe(422);
      expect(body.error).toMatch(/disagree/);

      // Prior state untouched: v1 stays active under the listing id, no entry
      // appears under the bundle's id, and v1's action is still invocable.
      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "twofaced-as")?.status).toBe("active");
      expect(cards.find((c) => c.id === "other-app")).toBeUndefined();
      const result = await harness.invokeAction("echo_twofaced_as", { after: "rejected v2" });
      expect(result).toMatchObject({ status: "ok" });
    });

    it("after appstore install, the bundle's action is invocable", async () => {
      const bundle = await buildAppStoreBundle("beta-as", "1.0.0", "echo_beta_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);

      await installAppstore(harness, bundle);
      await waitFor(() => harness.hasAction("echo_beta_as"));
      const result = await harness.invokeAction("echo_beta_as", { ping: 7 });
      expect(result).toMatchObject({
        status: "ok",
        data: { echoed: { ping: 7 }, appId: "beta-as" },
      });
    });

    it("uninstall removes an appstore-installed app and its action", async () => {
      const bundle = await buildAppStoreBundle("gamma-as", "1.0.0", "echo_gamma_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);
      await installAppstore(harness, bundle);
      await waitFor(() => harness.hasAction("echo_gamma_as"));

      const { status, body } = await uninstall(harness, "gamma-as");
      expect(status).toBe(200);
      expect(body).toEqual({ appId: "gamma-as", purged: false });

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "gamma-as")).toBeUndefined();
      expect(harness.hasAction("echo_gamma_as")).toBe(false);
    });

    it("appstore install → uninstall → install loop converges back to invocable action", async () => {
      const bundle = await buildAppStoreBundle("delta-as", "1.0.0", "echo_delta_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);

      await installAppstore(harness, bundle);
      await waitFor(() => harness.hasAction("echo_delta_as"));
      await uninstall(harness, "delta-as");
      expect(harness.hasAction("echo_delta_as")).toBe(false);

      await installAppstore(harness, bundle);
      await waitFor(() => harness.hasAction("echo_delta_as"));
      const result = await harness.invokeAction("echo_delta_as", { round: 2 });
      expect(result).toMatchObject({ data: { echoed: { round: 2 }, appId: "delta-as" } });
    });

    it("appstore install with a db-declaring bundle creates the prefixed table", async () => {
      const tablePrefix = "zas_db_pos";
      const bundle = await buildAppStoreBundle("asdb-pos", "1.0.0", "echo_asdb_pos", {
        db: { tablePrefix },
      });
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);

      const { status, body } = await installAppstore(harness, bundle);
      expect(status).toBe(200);
      expect(body.phase).toBe("installed");

      expect(sqliteHasTable(harness, `${tablePrefix}__widgets`)).toBe(true);
      expect(sqliteHasTable(harness, `__drizzle_migrations_app_${tablePrefix}`)).toBe(true);
    });

    it("contentHash mismatch fails install — phase=failed, action never registers", async () => {
      const bundle = await buildAppStoreBundle("mismatch-as", "1.0.0", "echo_mismatch_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);

      const wrongHash = "0".repeat(64);
      const { status, body } = await installAppstore(harness, bundle, {
        contentHashOverride: wrongHash,
      });
      expect(status).toBe(200);
      expect(body.phase).toBe("failed");
      expect(body.error).toMatch(/hash mismatch/i);
      expect(harness.hasAction("echo_mismatch_as")).toBe(false);

      const cards = await listApps(harness);
      const card = cards.find((c) => c.id === "mismatch-as");
      if (card) expect(card.status).not.toBe("active");
    });

    it("omitting contentHash resolves it from the registry and installs", async () => {
      const bundle = await buildAppStoreBundle("nohash-as", "1.0.0", "echo_nohash_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);
      romeCloudContentHashes.set(`${bundle.listingId}@${bundle.version}`, bundle.sha256);

      const { status, body } = await installAppstore(harness, bundle, {
        omitContentHash: true,
      });
      expect(status).toBe(200);
      expect(body.phase).toBe("installed");
      await waitFor(() => harness.hasAction("echo_nohash_as"));
    });

    it("omitting contentHash with no registry answer fails install", async () => {
      const bundle = await buildAppStoreBundle("nohash-miss-as", "1.0.0", "echo_nohash_miss_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);
      // romeCloudContentHashes intentionally not populated — getContentHash returns null.

      const { status, body } = await installAppstore(harness, bundle, {
        omitContentHash: true,
      });
      expect(status).toBe(200);
      expect(body.phase).toBe("failed");
      expect(body.error).toMatch(/did not return a contentHash/i);
      expect(harness.hasAction("echo_nohash_miss_as")).toBe(false);
    });

    it("omitting contentHash but registry hash disagrees with bytes — phase=failed", async () => {
      const bundle = await buildAppStoreBundle("nohash-bad-as", "1.0.0", "echo_nohash_bad_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);
      romeCloudContentHashes.set(`${bundle.listingId}@${bundle.version}`, "0".repeat(64));

      const { status, body } = await installAppstore(harness, bundle, {
        omitContentHash: true,
      });
      expect(status).toBe(200);
      expect(body.phase).toBe("failed");
      expect(body.error).toMatch(/hash mismatch/i);
      expect(harness.hasAction("echo_nohash_bad_as")).toBe(false);
    });

    it("bundleFetcher throw surfaces as phase=failed", async () => {
      // No bundleRegistry.set — fetcher throws.
      const bundle = await buildAppStoreBundle("unfetched-as", "1.0.0", "echo_unfetched_as");
      const { status, body } = await installAppstore(harness, bundle);
      expect(status).toBe(200);
      expect(body.phase).toBe("failed");
      expect(body.error).toMatch(/no fixture registered/);
      expect(harness.hasAction("echo_unfetched_as")).toBe(false);
    });

    it("an appstore install survives daemon restart", async () => {
      const bundle = await buildAppStoreBundle("persist-as", "1.0.0", "echo_persist_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);
      await installAppstore(harness, bundle);
      await waitFor(() => harness.hasAction("echo_persist_as"));

      // Restart probes by lockfile contentHash; the bundle is already on disk so
      // the fetcher is not invoked.
      await harness.restart();
      await waitFor(() => harness.hasAction("echo_persist_as"));

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "persist-as")?.status).toBe("active");
      const result = await harness.invokeAction("echo_persist_as", { after: "restart" });
      expect(result).toMatchObject({ status: "ok" });
    });

    it("workspace and appstore installs coexist; uninstalling one leaves the other invocable", async () => {
      const wsRoot = await buildWorkspaceApp(workspaceParent, "coexist-ws", "echo_coexist_ws");
      const bundle = await buildAppStoreBundle("coexist-as", "1.0.0", "echo_coexist_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);

      await installWorkspace(harness, "coexist-ws", wsRoot);
      await installAppstore(harness, bundle);
      await waitFor(
        () => harness.hasAction("echo_coexist_ws") && harness.hasAction("echo_coexist_as"),
      );

      await uninstall(harness, "coexist-ws");
      expect(harness.hasAction("echo_coexist_ws")).toBe(false);
      expect(harness.hasAction("echo_coexist_as")).toBe(true);

      const result = await harness.invokeAction("echo_coexist_as", { from: "after-ws-uninstall" });
      expect(result).toMatchObject({ data: { appId: "coexist-as" } });
    });
  });

  describe("K. Live MCP visibility across in-session app install", () => {
    it("MCP list_actions and execute_action see an action installed after openSession", async () => {
      const actionId = "livecat-app:livecat_echo";
      const { manager, provider, agentName } = await buildSessionManagerForHarness(harness);

      await manager.acquire({
        agentName,
        channelThreadKey: `e2e:live-actions:${Date.now()}`,
      });
      const server = provider.lastMcpServer();

      const beforeActions = parseMcpJson<Array<{ name: string }>>(
        await callMcpTool(server, "actions", "list_actions"),
      );
      expect(beforeActions.map((a) => a.name)).not.toContain(actionId);
      const missingAction = await callMcpTool(server, "actions", "execute_action", {
        action_name: actionId,
        json_args: { ping: 1 },
      });
      expect(missingAction.isError).toBe(true);
      expect(missingAction.content[0]?.text).toContain(`Unknown action: ${actionId}`);

      const appRoot = await buildWorkspaceApp(workspaceParent, "livecat-app", "livecat_echo");
      await installWorkspace(harness, "livecat-app", appRoot);
      await waitFor(() => harness.hasAction("livecat_echo"));

      const afterActions = parseMcpJson<Array<{ name: string }>>(
        await callMcpTool(server, "actions", "list_actions"),
      );
      expect(afterActions.map((a) => a.name)).toContain(actionId);
      const result = parseMcpJson<{ echoed: { ping: number }; appId: string }>(
        await callMcpTool(server, "actions", "execute_action", {
          action_name: actionId,
          json_args: { ping: 1 },
        }),
      );
      expect(result).toMatchObject({ echoed: { ping: 1 }, appId: "livecat-app" });
    });

    it("MCP list_skills and read_skill see a skill installed after openSession", async () => {
      const skillId = "liveskill-app:liveskill-demo";
      const { manager, provider, agentName } = await buildSessionManagerForHarness(harness);

      await manager.acquire({
        agentName,
        channelThreadKey: `e2e:live-skills:${Date.now()}`,
      });
      const server = provider.lastMcpServer();

      const beforeSkills = parseMcpJson<Array<{ name: string }>>(
        await callMcpTool(server, "skills", "list_skills"),
      );
      expect(beforeSkills.map((s) => s.name)).not.toContain(skillId);

      const appRoot = await writeAppWithSkillFixture(
        workspaceParent,
        "liveskill-app",
        "liveskill_echo",
        {
          dir: "liveskill-demo",
          publicName: "liveskill-demo",
          description: "Demonstrates a skill installed mid-session",
          tools: ["liveskill_echo"],
        },
      );
      await installWorkspace(harness, "liveskill-app", appRoot);
      // The skill catalog subscriber runs after the action loader; wait on
      // the skill itself, not just the action — otherwise we might race the
      // catalog refresh and assert before skillCatalog.loadFromCatalog has run.
      await waitFor(() => harness.skillCatalog.getMcpDefinitions().some((s) => s.name === skillId));

      const skills = parseMcpJson<Array<{ name: string; description: string; tools?: string[] }>>(
        await callMcpTool(server, "skills", "list_skills"),
      );
      expect(skills.map((s) => s.name)).toContain(skillId);
      const skill = skills.find((s) => s.name === skillId)!;
      expect(skill.description).toBe("Demonstrates a skill installed mid-session");
      expect(skill.tools).toEqual(["liveskill_echo"]);
      const fullSkill = parseMcpJson<{ name: string; content: string }>(
        await callMcpTool(server, "skills", "read_skill", {
          skill_name: skillId,
        }),
      );
      expect(fullSkill.content).toContain("# liveskill-demo");
    });
  });

  describe("L. Upgrade detection via GET /apps/updates", () => {
    interface UpgradeCandidatePayload {
      appId: string;
      currentVersion: string;
      availableVersion: string;
      targetSource:
        | { mode: "bundle"; path: string }
        | { mode: "appstore"; listingId: string; version: string };
    }
    interface UpdatesResponse {
      upgradable: UpgradeCandidatePayload[];
    }

    async function getUpdates(): Promise<UpdatesResponse> {
      const res = await harness.fetch("/apps/updates");
      expect(res.status).toBe(200);
      return (await res.json()) as UpdatesResponse;
    }

    async function bumpManifestVersion(appRoot: string, nextVersion: string): Promise<void> {
      const manifestPath = join(appRoot, "app.yaml");
      const raw = await readFile(manifestPath, "utf-8");
      const replaced = raw.replace(/^version:\s.*$/m, `version: ${nextVersion}`);
      if (replaced === raw) {
        throw new Error(`bumpManifestVersion: no version line found in ${manifestPath}`);
      }
      await writeFile(manifestPath, replaced, "utf-8");
    }

    async function packSeed(seedRoot: string, appId: string): Promise<string> {
      const packedRoot = `${seedRoot}.packed`;
      await rm(packedRoot, { recursive: true, force: true });
      const packed = await packArtifact(seedRoot, packedRoot, { appId });
      return packed.outDir;
    }

    afterEach(() => {
      rs.unstubAllEnvs();
    });

    it("flags a workspace app under rome_apps/ whose app.yaml advertises a newer version", async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), "rome-upd-seed-"));
      const seedRoot = join(projectRoot, "rome_apps", "first-up");
      await mkdir(seedRoot, { recursive: true });
      await writeAppFixture(seedRoot, {
        id: "first-up",
        actionName: "echo_first_up",
        version: "0.1.0",
      });
      rs.stubEnv("ROME_PROJECT_ROOT", projectRoot);

      const packedRoot = await packSeed(seedRoot, "first-up");
      await installWorkspace(harness, "first-up", packedRoot);
      await bumpManifestVersion(seedRoot, "0.2.0");
      await packSeed(seedRoot, "first-up");

      const { upgradable } = await getUpdates();
      expect(upgradable).toEqual([
        {
          appId: "first-up",
          currentVersion: "0.1.0",
          availableVersion: "0.2.0",
          targetSource: { mode: "bundle", path: packedRoot },
        },
      ]);
    });

    it("flags a workspace app under a custom authoring root whose app.yaml advertises a newer version", async () => {
      const authoringRoot = await mkdtemp(join(tmpdir(), "rome-upd-custom-"));
      const devRoot = join(authoringRoot, "prof-up");
      await mkdir(devRoot, { recursive: true });
      await writeAppFixture(devRoot, {
        id: "prof-up",
        actionName: "echo_prof_up",
        version: "0.1.0",
      });
      rs.stubEnv("ROME_APP_AUTHORING_ROOT", authoringRoot);

      const packedRoot = await packSeed(devRoot, "prof-up");
      await installWorkspace(harness, "prof-up", packedRoot);
      await bumpManifestVersion(devRoot, "0.2.0");
      await packSeed(devRoot, "prof-up");

      const { upgradable } = await getUpdates();
      expect(upgradable).toEqual([
        {
          appId: "prof-up",
          currentVersion: "0.1.0",
          availableVersion: "0.2.0",
          targetSource: { mode: "bundle", path: packedRoot },
        },
      ]);
    });

    it("flags an appstore app when Rome Cloud advertises a newer version", async () => {
      const bundle = await buildAppStoreBundle("as-up", "1.0.0", "echo_as_up");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);
      await installAppstore(harness, bundle);
      romeCloudHighestVersions.set("as-up", "1.1.0");

      const { upgradable } = await getUpdates();
      expect(upgradable).toEqual([
        {
          appId: "as-up",
          currentVersion: "1.0.0",
          availableVersion: "1.1.0",
          targetSource: { mode: "appstore", listingId: "as-up", version: "1.1.0" },
        },
      ]);
    });

    it("returns empty upgradable[] when no source advertises a newer version", async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), "rome-upd-noop-"));
      const seedRoot = join(projectRoot, "rome_apps", "noop-fp");
      await mkdir(seedRoot, { recursive: true });
      await writeAppFixture(seedRoot, {
        id: "noop-fp",
        actionName: "echo_noop_fp",
        version: "0.1.0",
      });
      rs.stubEnv("ROME_PROJECT_ROOT", projectRoot);
      const packedRoot = await packSeed(seedRoot, "noop-fp");
      await installWorkspace(harness, "noop-fp", packedRoot);

      const bundle = await buildAppStoreBundle("noop-as", "1.0.0", "echo_noop_as");
      bundleRegistry.set(bundleKey(bundle), bundle.bytes);
      await installAppstore(harness, bundle);
      // romeCloudHighestVersions intentionally empty — no advertised upgrade.

      const { upgradable } = await getUpdates();
      expect(upgradable).toEqual([]);
    });
  });

  describe("M. One-step source mode", () => {
    it("POST with mode=source builds+packs+installs from the repo in one call", async () => {
      const repo = await buildSourceApp(workspaceParent, "one-step", "echo_one_step");

      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { mode: "source", path: repo } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as InstallResponseBody;
      expect(body.appId).toBe("one-step");
      expect(body.phase).toBe("installed");
      expect(body.spec.source).toEqual({ mode: "source", path: repo });

      // The daemon packed into the conventional in-repo artifact dir.
      expect(existsSync(join(repo, ".rome", "artifact", "app.yaml"))).toBe(true);

      await waitFor(() => harness.hasAction("echo_one_step"));
      const result = await harness.invokeAction("echo_one_step", { via: "one-step" });
      expect(result).toMatchObject({ status: "ok" });
    });

    it("POST mode=source pointed at a packed artifact is rejected with the bundle alternative", async () => {
      const packed = await buildWorkspaceApp(workspaceParent, "wrong-mode", "echo_wrong_mode");

      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { mode: "source", path: packed } }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/packed artifact, not a source workspace[\s\S]*"bundle"/);
    });

    it("POST mode=bundle pointed at a source repo is rejected with the source install named", async () => {
      const repo = await buildSourceApp(workspaceParent, "raw-as-bundle", "echo_raw_as_bundle");

      const res = await harness.fetch("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { mode: "bundle", path: repo } }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/source workspace, not a packed artifact[\s\S]*"source"/);
    });
  });

  describe("N. First-party immutability", () => {
    // Boot installs first-party artifacts with `firstParty: true`; simulate
    // that install here, then drive the uninstall attempts through the same
    // public surfaces a user would hit.
    async function installFirstParty(appId: string, actionName: string): Promise<void> {
      const packedRoot = await buildWorkspaceApp(workspaceParent, appId, actionName);
      const result = await harness.appManager.install({
        source: { mode: "bundle", path: packedRoot },
        firstParty: true,
      });
      expect(result.state).toBe("installed");
    }

    it("DELETE /apps/:id returns 400 for a first-party app and the app stays installed", async () => {
      await installFirstParty("inboxish", "echo_inboxish");

      const res = await harness.fetch("/apps/inboxish", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/cannot be uninstalled/i);

      const cards = await listApps(harness);
      const card = cards.find((c) => c.id === "inboxish");
      expect(card?.status).toBe("active");
    });

    it("GET /apps reports canUninstall: false for first-party apps and true for user apps", async () => {
      await installFirstParty("firstish", "echo_firstish");
      const userAppRoot = await buildWorkspaceApp(workspaceParent, "userish", "echo_userish");
      await installWorkspace(harness, "userish", userAppRoot);

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "firstish")?.canUninstall).toBe(false);
      expect(cards.find((c) => c.id === "userish")?.canUninstall).toBe(true);
    });

    it("the app_management uninstall path rejects a first-party app too", async () => {
      await installFirstParty("guarded", "echo_guarded");
      const lifecycle = new AppLifecycleService(harness.appManager, harness.appCatalog, harness.db);

      await expect(lifecycle.uninstall({ appId: "guarded" })).rejects.toMatchObject({
        name: "AppManagerError",
        code: "FIRST_PARTY_PROTECTED",
      });

      const cards = await listApps(harness);
      expect(cards.find((c) => c.id === "guarded")?.status).toBe("active");
    });

    it("a first-party app can still be disabled and re-enabled via PATCH", async () => {
      await installFirstParty("toggleable", "echo_toggleable");

      const disable = await harness.fetch("/apps/toggleable", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(disable.status).toBe(200);
      expect((await listApps(harness)).find((c) => c.id === "toggleable")?.isEnabled).toBe(false);

      const enable = await harness.fetch("/apps/toggleable", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(enable.status).toBe(200);
      expect((await listApps(harness)).find((c) => c.id === "toggleable")?.isEnabled).toBe(true);
    });
  });
});
