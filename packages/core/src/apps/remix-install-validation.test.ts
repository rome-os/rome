import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import type { AppCatalog } from "./catalog.js";
import type { AppInstaller } from "./installer.js";
import { validateRemixInstallIsolation } from "./remix-install-validation.js";
import type { ResolvedApp } from "./state.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rome-remix-isolation-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function actionYaml(name: string): string {
  return [
    `name: ${name}`,
    "type: custom",
    "description: Remix isolation test action",
    "complexity: simple",
    "speed: fast",
    "reliability: high",
    "sideEffects: read-only",
    "",
  ].join("\n");
}

function agentYaml(name: string, options: { legacyOutputSchema?: boolean } = {}): string {
  return [
    `name: ${name}`,
    "description: Remix isolation test agent",
    "tier: large",
    "systemPromptPrefix: Remix isolation test.",
    "tools: []",
    "permissionMode: default",
    ...(options.legacyOutputSchema
      ? [
          "outputSchema:",
          "  type: object",
          "  properties:",
          "    ok:",
          "      type: boolean",
          "  required: [ok]",
        ]
      : []),
    "",
  ].join("\n");
}

async function writeRemixSource(
  root: string,
  options: {
    actionName?: string;
    agentName?: string;
    skillName?: string;
    tablePrefix?: string;
    migrationSql?: string;
  },
): Promise<void> {
  const manifest = [
    "formatVersion: 1",
    "id: ray-calendar",
    "name: '@ray/calendar'",
    "version: 1.2.3",
    "description: Remixed calendar",
    "remix:",
    "  listing: '@alice/calendar'",
    "  version: 1.2.3",
    ...(options.actionName ? ["actions:", "  - actions/calendar-lookup"] : ["actions: []"]),
    ...(options.agentName ? ["agents:", "  - agents/calendar-helper/agent.yaml"] : ["agents: []"]),
    ...(options.skillName ? ["skills:", "  - skills/calendar-help"] : ["skills: []"]),
    "hooks: []",
    ...(options.tablePrefix
      ? ["db:", "  migrations: db/migrations", `  tablePrefix: ${options.tablePrefix}`]
      : []),
    "",
  ].join("\n");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "app.yaml"), manifest);
  if (options.actionName) {
    await mkdir(join(root, "actions", "calendar-lookup"), { recursive: true });
    await writeFile(
      join(root, "actions", "calendar-lookup", "action.yaml"),
      actionYaml(options.actionName),
    );
  }
  if (options.agentName) {
    await mkdir(join(root, "agents", "calendar-helper"), { recursive: true });
    await writeFile(
      join(root, "agents", "calendar-helper", "agent.yaml"),
      agentYaml(options.agentName),
    );
  }
  if (options.skillName) {
    await mkdir(join(root, "skills", "calendar-help"), { recursive: true });
    await writeFile(
      join(root, "skills", "calendar-help", "SKILL.md"),
      [
        "---",
        `name: ${options.skillName}`,
        "description: Calendar help",
        "---",
        "",
        "# Calendar Help",
        "",
      ].join("\n"),
    );
  }
  if (options.tablePrefix) {
    await mkdir(join(root, "db", "migrations"), { recursive: true });
    await writeFile(
      join(root, "db", "migrations", "0000_init.sql"),
      options.migrationSql ??
        `CREATE TABLE \`${options.tablePrefix}__events\` (\`id\` text PRIMARY KEY);\n`,
    );
  }
}

async function sourceApp(
  root: string,
  options: { agentName?: string; legacyAgent?: boolean; skillName?: string } = {},
): Promise<ResolvedApp> {
  const actionRoot = join(root, "installed-action");
  const agentPath = join(root, "installed-agent", "agent.yaml");
  const skillRoot = join(root, "installed-skill");
  await mkdir(actionRoot, { recursive: true });
  await writeFile(join(actionRoot, "action.yaml"), actionYaml("calendar_lookup"));
  if (options.agentName) {
    await mkdir(dirname(agentPath), { recursive: true });
    await writeFile(
      agentPath,
      agentYaml(options.agentName, { legacyOutputSchema: options.legacyAgent }),
    );
  }
  if (options.skillName) {
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      ["---", `name: ${options.skillName}`, "description: Calendar help", "---", ""].join("\n"),
    );
  }
  return {
    appId: "calendar",
    manifest: { id: "calendar", version: "1.2.3" },
    rootPath: root,
    resolveRoot: root,
    displayName: "Calendar",
    iconAbsolutePath: undefined,
    web: null,
    api: null,
    state: "installed",
    enabled: true,
    source: {
      mode: "appstore",
      listingId: "@alice/calendar",
      version: "1.2.3",
      contentHash: "source-hash",
    },
    installedVersion: "1.2.3",
    db: {
      appId: "calendar",
      migrationsPath: join(root, "installed-migrations"),
      migrationsTable: "__drizzle_migrations_app_calendar",
      tablePrefix: "calendar",
    },
    artifacts: {
      action: [
        {
          kind: "action",
          publicName: "calendar_lookup",
          aliases: [],
          ownerType: "app",
          ownerId: "calendar",
          absolutePath: actionRoot,
        },
      ],
      agent: options.agentName
        ? [
            {
              kind: "agent",
              publicName: options.agentName,
              aliases: [],
              ownerType: "app",
              ownerId: "calendar",
              absolutePath: agentPath,
            },
          ]
        : [],
      skill: options.skillName
        ? [
            {
              kind: "skill",
              publicName: options.skillName,
              aliases: [],
              ownerType: "app",
              ownerId: "calendar",
              absolutePath: skillRoot,
            },
          ]
        : [],
      hook: [],
    },
  } as unknown as ResolvedApp;
}

function catalogWith(app: ResolvedApp): AppCatalog {
  return { list: () => [app], listResolved: () => [app] } as unknown as AppCatalog;
}

const unusedInstaller = {
  resolve: async () => ({ ok: false, reason: "unexpected resolve" }),
} as unknown as AppInstaller;

function disabledCatalogAndInstaller(app: ResolvedApp): {
  catalog: AppCatalog;
  installer: AppInstaller;
} {
  const { manifest: _manifest, artifacts: _artifacts, db: _db, ...disabledView } = app;
  const catalog = {
    list: () => [{ ...disabledView, enabled: false }],
    listResolved: () => [],
  } as unknown as AppCatalog;
  const installer = {
    resolve: async () => ({
      ok: true as const,
      manifest: app.manifest,
      rootPath: app.rootPath,
      resolveRoot: app.resolveRoot,
      displayName: app.displayName,
      iconAbsolutePath: app.iconAbsolutePath,
      artifacts: app.artifacts,
      web: app.web,
      api: app.api,
      db: app.db,
    }),
  } as unknown as AppInstaller;
  return { catalog, installer };
}

describe("validateRemixInstallIsolation", () => {
  it("rejects an action name that still collides with the installed source app", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { actionName: "calendar_lookup" });

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(await sourceApp(root)),
        unusedInstaller,
      ),
    ).rejects.toThrow(/REMIX_ARTIFACT_CONFLICT.*calendar_lookup.*calendar/);
  });

  it("rejects a skill name that still collides with the installed source app", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { skillName: "calendar_help" });

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(await sourceApp(root, { skillName: "calendar_help" })),
        unusedInstaller,
      ),
    ).rejects.toThrow(/REMIX_ARTIFACT_CONFLICT.*calendar_help.*calendar/);
  });

  it("rejects a database prefix already owned by the installed source app", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { tablePrefix: "calendar" });

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(await sourceApp(root)),
        unusedInstaller,
      ),
    ).rejects.toThrow(/REMIX_DB_NAMESPACE_CONFLICT.*calendar/);
  });

  it("rejects copied migrations that still address the source app tables", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, {
      tablePrefix: "ray_calendar",
      migrationSql: "CREATE TABLE `calendar__events` (`id` text PRIMARY KEY);\n",
    });

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(await sourceApp(root)),
        unusedInstaller,
      ),
    ).rejects.toThrow(/REMIX_DB_MIGRATIONS_NOT_ISOLATED.*calendar.*ray_calendar/);
  });

  it("rejects copied migration metadata that still uses the source namespace", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, {
      tablePrefix: "ray_calendar",
      migrationSql: "CREATE TABLE `__drizzle_migrations_app_calendar` (`id` text);\n",
    });

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(await sourceApp(root)),
        unusedInstaller,
      ),
    ).rejects.toThrow(/REMIX_DB_MIGRATIONS_NOT_ISOLATED.*calendar.*ray_calendar/);
  });

  it("rejects copied migrations when the source app is disabled", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, {
      tablePrefix: "ray_calendar",
      migrationSql: "CREATE TABLE `calendar__events` (`id` text PRIMARY KEY);\n",
    });
    const deps = disabledCatalogAndInstaller(await sourceApp(root));

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        deps.catalog,
        deps.installer,
      ),
    ).rejects.toThrow(/REMIX_DB_MIGRATIONS_NOT_ISOLATED.*calendar.*ray_calendar/);
  });

  it("rejects copied migrations after the source app upgrades", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, {
      tablePrefix: "ray_calendar",
      migrationSql: "CREATE TABLE `calendar__events` (`id` text PRIMARY KEY);\n",
    });
    const upgraded = await sourceApp(root);
    upgraded.installedVersion = "2.0.0";

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(upgraded),
        unusedInstaller,
      ),
    ).rejects.toThrow(/REMIX_DB_MIGRATIONS_NOT_ISOLATED.*calendar.*ray_calendar/);
  });

  it("ignores an unrelated installed agent whose legacy output schema no longer validates", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { actionName: "ray_calendar__calendar_lookup" });

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(await sourceApp(root, { agentName: "synthesizer", legacyAgent: true })),
        unusedInstaller,
      ),
    ).resolves.toBeUndefined();
  });

  it("ignores a legacy installed agent when its app is disabled", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { actionName: "ray_calendar__calendar_lookup" });
    const deps = disabledCatalogAndInstaller(
      await sourceApp(root, { agentName: "synthesizer", legacyAgent: true }),
    );

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        deps.catalog,
        deps.installer,
      ),
    ).resolves.toBeUndefined();
  });

  it("ignores an unrelated installed action whose config no longer validates", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { actionName: "ray_calendar__calendar_lookup" });
    const installed = await sourceApp(root);
    await writeFile(
      join(root, "installed-action", "action.yaml"),
      `${actionYaml("calendar_lookup")}legacyField: true\n`,
    );

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(installed),
        unusedInstaller,
      ),
    ).resolves.toBeUndefined();
  });

  it("ignores an unrelated installed skill that has no description", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { actionName: "ray_calendar__calendar_lookup" });
    const installed = await sourceApp(root, { skillName: "calendar_help" });
    await writeFile(join(root, "installed-skill", "SKILL.md"), "---\nname: calendar_help\n---\n");

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(installed),
        unusedInstaller,
      ),
    ).resolves.toBeUndefined();
  });

  it("still rejects an installed agent whose name collides with the remixed target", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { agentName: "calendar_helper" });

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(await sourceApp(root, { agentName: "calendar_helper" })),
        unusedInstaller,
      ),
    ).rejects.toThrow(/REMIX_ARTIFACT_CONFLICT.*calendar_helper.*calendar/);
  });

  it("still fails when an installed agent's YAML cannot be read", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { actionName: "ray_calendar__calendar_lookup" });
    const installed = await sourceApp(root, { agentName: "synthesizer" });
    await writeFile(join(root, "installed-agent", "agent.yaml"), "name: [unclosed\n");

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(installed),
        unusedInstaller,
      ),
    ).rejects.toThrow(/Cannot read installed agent name/);
  });

  it("still fails when an installed agent's name cannot be used", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, { actionName: "ray_calendar__calendar_lookup" });
    const installed = await sourceApp(root, { agentName: "synthesizer" });
    await writeFile(join(root, "installed-agent", "agent.yaml"), agentYaml("bad:name"));

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(installed),
        unusedInstaller,
      ),
    ).rejects.toThrow(/Cannot read installed agent name/);
  });

  it("accepts namespaced artifacts and a fresh target database baseline", async () => {
    const root = await tempRoot();
    const remixRoot = join(root, "remix");
    await writeRemixSource(remixRoot, {
      actionName: "ray_calendar__calendar_lookup",
      skillName: "ray_calendar__calendar_help",
      tablePrefix: "ray_calendar",
    });

    await expect(
      validateRemixInstallIsolation(
        { mode: "source", path: remixRoot },
        catalogWith(await sourceApp(root, { skillName: "calendar_help" })),
        unusedInstaller,
      ),
    ).resolves.toBeUndefined();
  });
});
