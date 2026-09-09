import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AppInstallResponse,
  AppArtifactDetails,
  AppArtifactSummary,
  AppAccessMode,
  AppDetailResponse,
  AppListResponse,
  AppOrigin,
  AppPublishResponse,
  AppReadmeResponse,
  InstalledAppCard,
  SpecSource,
} from "@rome/api-types/apps";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { parse as parseYaml } from "yaml";
import type { AppCatalog } from "../../apps/catalog.js";
import type { AppManager } from "../../apps/manager.js";
import { AppManagerError, SYSTEM_APP_ID } from "../../apps/manager.js";
import { deriveRuntimeStatusFromView } from "../../apps/runtime-status-subscriber.js";
import { SpecSourceSchema } from "../../apps/lockfile.js";
import type { ArtifactRef, ResolvedApp } from "../../apps/state.js";
import { purgeAppUserData, resolveTablePrefixForPurge } from "../../apps/user-data-purge.js";
import { appIdToPathSegment, assertValidAppId } from "../../apps/packaging/index.js";
import { isPublishableSource, publishAppBundle, publishArtifactRoot } from "../../apps/publish.js";
import { findUpgradeCandidates } from "../../apps/upgrade-detector.js";
import { parseSkillFrontmatterResult } from "../../core/skill-catalog.js";
import { getProfileAppsDir, getProjectsRoot } from "../../paths.js";
import { settings } from "../../db/schema.js";
import {
  DEFAULT_PUBLIC_ACCESS_CONFIG,
  normalizePublicAccessConfig,
  type PublicAccessConfig,
} from "../../lib/public-access-config.js";
import { resolveGuardianSession } from "../../lib/guardian-session.js";
import { resolveVisitorSession } from "../../lib/visitor-session.js";
import { enrichGuardianActor } from "../../lib/session-actor.js";
import type { ApiDeps } from "../deps.js";
import { APP_MANAGER_ERROR_STATUS } from "@rome/api-types/app-manager-errors";
import { getEmbeddedAppHref, getFullAppHref } from "../../lib/app-routes.js";

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function isResolvedApp(view: unknown): view is ResolvedApp {
  return (view as ResolvedApp).manifest !== undefined;
}

// Provenance for the dashboard's grouped apps page. `firstParty` wins over the
// source mode: boot installs first-party apps as local bundles, so a bundle
// source alone cannot distinguish "ships with Rome" from "packed by the user".
function deriveAppOrigin(view: ReturnType<AppCatalog["list"]>[number]): AppOrigin {
  if (view.firstParty) return "builtin";
  if (view.source.mode === "appstore") return "appstore";
  return "local";
}

export function deriveAppProjectPath(
  source: SpecSource,
  projectsRoot: string = getProjectsRoot(),
): string | null {
  if (source.mode !== "source") return null;

  const relativePath = relative(resolve(projectsRoot), resolve(source.path));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return null;
  if (isAbsolute(relativePath)) return null;

  return relativePath.split(sep).join("/");
}

function toInstalledAppCard(
  view: ReturnType<AppCatalog["list"]>[number],
  publicAccess: PublicAccessConfig,
  capabilityDetails: AppArtifactDetails,
): InstalledAppCard {
  const resolved = isResolvedApp(view) ? view : null;
  const hasFrontend = !!resolved?.web;
  const status = deriveRuntimeStatusFromView(view);
  const isActive = status === "active";
  const isPublic = publicAccess.allowedApps.includes(view.appId);
  const cloudAllowedEmails = publicAccess.cloudEmailAccess[view.appId] ?? [];
  const accessMode: AppAccessMode = isPublic
    ? "public"
    : cloudAllowedEmails.length > 0
      ? "cloud-email"
      : "private";

  return {
    id: view.appId,
    version: resolved?.manifest.version ?? view.installedVersion ?? "unknown",
    description:
      resolved?.manifest.description ??
      (status === "disabled"
        ? "This app is installed but disabled."
        : status === "failed"
          ? "This app failed to start and was skipped during boot."
          : "Installing…"),
    // view.displayName/iconAbsolutePath also cover installed-but-disabled apps,
    // which the catalog leaves unresolved but decorates with display metadata.
    displayName: view.displayName ?? view.appId,
    status,
    phase: view.state,
    error: view.lastError?.message,
    hasFrontend,
    href: isActive && hasFrontend ? getEmbeddedAppHref(view.appId) : null,
    fullHref: isActive && hasFrontend ? getFullAppHref(view.appId) : null,
    capabilities: [
      formatCount(resolved?.artifacts.agent.length ?? 0, "agent"),
      formatCount(resolved?.artifacts.action.length ?? 0, "action"),
      formatCount(resolved?.artifacts.skill.length ?? 0, "skill"),
      formatCount(resolved?.artifacts.hook.length ?? 0, "hook"),
    ],
    capabilityDetails,
    isEnabled: view.enabled,
    canToggle: view.appId !== SYSTEM_APP_ID,
    // First-party apps ship with Rome and are immutable to users (the daemon
    // rejects the uninstall too); enable/disable remains available above.
    canUninstall: view.appId !== SYSTEM_APP_ID && !view.firstParty,
    includeSource: view.includeSource === true,
    canPublish:
      view.state === "installed" &&
      view.appId !== SYSTEM_APP_ID &&
      isPublishableSource(view.appId, view.source),
    accessMode,
    isPublic,
    cloudAllowedEmails,
    canManagePublicAccess: hasFrontend,
    iconUrl: view.iconAbsolutePath ? `/api/apps/${appIdToPathSegment(view.appId)}/icon` : null,
    source: view.source,
    projectPath: deriveAppProjectPath(view.source),
    origin: deriveAppOrigin(view),
    suggestedChannelBindings: resolved?.manifest.suggestedChannelBindings ?? [],
  };
}

function sourceInstalledRank(card: InstalledAppCard): number {
  return card.source.mode === "source" ? 0 : 1;
}

function rankSourceInstalledAppsFirst(cards: InstalledAppCard[]): InstalledAppCard[] {
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => sourceInstalledRank(a.card) - sourceInstalledRank(b.card) || a.index - b.index)
    .map(({ card }) => card);
}

function emptyArtifactDetails(): AppArtifactDetails {
  return { agents: [], actions: [], skills: [], hooks: [] };
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fallbackDescription(kind: ArtifactRef["kind"], publicName: string): string {
  if (kind === "hook") return `Registered ${publicName} hook.`;
  return "No description provided.";
}

async function readYamlSummary(filePath: string, ref: ArtifactRef): Promise<AppArtifactSummary> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseYaml(raw);
    if (isStringRecord(parsed)) {
      return {
        name: cleanSummary(parsed.name) ?? ref.publicName,
        description:
          cleanSummary(parsed.description) ?? fallbackDescription(ref.kind, ref.publicName),
      };
    }
  } catch {}

  return {
    name: ref.publicName,
    description: fallbackDescription(ref.kind, ref.publicName),
  };
}

async function readSkillSummary(ref: ArtifactRef): Promise<AppArtifactSummary> {
  let raw: string;
  try {
    raw = await readFile(join(ref.absolutePath, "SKILL.md"), "utf-8");
  } catch {
    // The skill is declared in the manifest but its SKILL.md is unreadable —
    // that is a load failure, not a healthy skill missing a description. Carry
    // the reason so the card can flag it instead of silently degrading.
    return {
      name: ref.publicName,
      description: fallbackDescription(ref.kind, ref.publicName),
      loadError: "SKILL.md could not be read",
    };
  }

  const parsed = parseSkillFrontmatterResult(raw.trim());
  if (parsed.ok) {
    return {
      name: parsed.value.name,
      description: parsed.value.description,
    };
  }

  // Surface the diagnostic reason (bad/whitespace name, missing field, …) so
  // the author sees why the declared skill did not load.
  return {
    name: ref.publicName,
    description: fallbackDescription(ref.kind, ref.publicName),
    loadError: parsed.message,
  };
}

async function readArtifactSummary(ref: ArtifactRef): Promise<AppArtifactSummary> {
  if (ref.kind === "action") {
    return readYamlSummary(join(ref.absolutePath, "action.yaml"), ref);
  }
  if (ref.kind === "agent") {
    return readYamlSummary(ref.absolutePath, ref);
  }
  if (ref.kind === "skill") {
    return readSkillSummary(ref);
  }
  return {
    name: ref.publicName,
    description: fallbackDescription(ref.kind, ref.publicName),
  };
}

async function loadArtifactDetailsByApp(
  catalog: AppCatalog,
): Promise<Map<string, AppArtifactDetails>> {
  const byApp = new Map<string, AppArtifactDetails>();

  async function append(
    key: keyof AppArtifactDetails,
    refs: readonly ArtifactRef[],
  ): Promise<void> {
    await Promise.all(
      refs
        .filter((ref) => ref.ownerType === "app")
        .map(async (ref) => {
          const details = byApp.get(ref.ownerId) ?? emptyArtifactDetails();
          byApp.set(ref.ownerId, details);
          details[key].push(await readArtifactSummary(ref));
        }),
    );
  }

  await Promise.all([
    append("agents", catalog.listArtifacts("agent")),
    append("actions", catalog.listArtifacts("action")),
    append("skills", catalog.listArtifacts("skill")),
    append("hooks", catalog.listArtifacts("hook")),
  ]);

  for (const details of byApp.values()) {
    details.agents.sort((a, b) => a.name.localeCompare(b.name));
    details.actions.sort((a, b) => a.name.localeCompare(b.name));
    details.skills.sort((a, b) => a.name.localeCompare(b.name));
    details.hooks.sort((a, b) => a.name.localeCompare(b.name));
  }

  return byApp;
}

async function loadPublicAccessConfig(deps: ApiDeps): Promise<PublicAccessConfig> {
  const rows = await deps.db.select().from(settings).where(eq(settings.key, "publicAccess"));
  return rows.length > 0 && rows[0].value
    ? normalizePublicAccessConfig(rows[0].value)
    : DEFAULT_PUBLIC_ACCESS_CONFIG;
}

const ICON_MIME_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

function appManagerErrorResponse(c: Context, err: unknown) {
  if (err instanceof AppManagerError) {
    return c.json({ error: err.message }, APP_MANAGER_ERROR_STATUS[err.code]);
  }
  return c.json({ error: getErrorMessage(err) }, 500);
}

function assertAppIdIsNotSystem(c: Context, appId: string, verbMessage: string) {
  if (appId === SYSTEM_APP_ID) {
    return c.json({ error: `SYSTEM_PROTECTED: ${verbMessage}` }, 400);
  }
  return null;
}

export function appsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // Registered before the `:appId` GET so a human reader can see the static
  // segment wins without having to trust Hono's router precedence.
  app.get("/apps/updates", async (c) => {
    const summary = await findUpgradeCandidates(deps.appCatalog, {
      romeCloudListings: deps.romeCloudListings,
    });
    c.header("Cache-Control", "no-store");
    return c.json(summary);
  });

  // Guardian-gated SSE stream of catalog changes: a `{ appId, change }` frame
  // per "added" / "changed" / "removed" event, with no asset or manifest data
  // on the wire. The dashboard's embedded app view filters client-side to the
  // app it currently has open.
  //
  // Registered before the `:appId` GET so the static segment wins, reserving
  // "events" as an app id — same trick as `/apps/updates` above.
  //
  // Guardian-only on purpose: app existence and change-timing must never leak
  // to visitors or anonymous callers, so the gate runs before the stream opens.
  app.get("/apps/events", async (c) => {
    const guardian = await resolveGuardianSession(c, deps.db);
    if (!guardian) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    return streamSSE(c, async (sse) => {
      let close!: () => void;
      let finished = false;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        close();
      };
      // Fire-and-forget the write; do NOT return its promise. The catalog
      // awaits each subscriber inside `fireEvent`, which runs under its global
      // `refreshMutex` — the mutex that serializes every app
      // install/uninstall/enable/disable. Returning the `writeSSE` promise here
      // would tie that mutex to a live network write that can hang indefinitely
      // on a stalled or half-dead client (stream backpressure leaves
      // `writer.write()` pending), stalling app lifecycle instance-wide.
      // Returning void keeps refresh decoupled from this connection, and
      // successive writes stay ordered by the underlying writer.
      //
      // Teardown on a dead client comes from `onAbort` (reader cancel / request
      // abort) → `finish`, below. The `.catch(finish)` here is only a defensive
      // backstop: Hono's StreamingApi.write() swallows write errors and never
      // rejects, so it does not fire on a failed write today — it's kept in case
      // that ever changes, matching the system-upgrade route.
      unsubscribe = deps.appCatalog.subscribe(function catalogEventStream(event) {
        sse
          .writeSSE({
            event: "catalog-change",
            data: JSON.stringify({ appId: event.appId, change: event.change }),
          })
          .catch(finish);
      });
      heartbeat = setInterval(() => {
        sse.writeSSE({ event: "keepalive", data: "" }).catch(finish);
      }, 20_000);
      sse.onAbort(finish);
      await closed;
    });
  });

  app.get("/apps/:appId/icon", async (c) => {
    const appId = c.req.param("appId");
    try {
      assertValidAppId(appId);
    } catch {
      return c.json({ error: "Invalid app id" }, 400);
    }
    // Disabled apps carry iconAbsolutePath on the bare view, so their icon
    // still serves (the dashboard shows a grayed-out version of it).
    const view = deps.appCatalog.get(appId);
    const iconPath = view?.iconAbsolutePath ?? null;
    if (!iconPath) {
      return c.json({ error: `App "${appId}" has no icon` }, 404);
    }
    const ext = extname(iconPath).toLowerCase();
    const mime = ICON_MIME_TYPES[ext];
    if (!mime) {
      return c.json({ error: `Unsupported icon type "${ext}"` }, 415);
    }
    try {
      const [buffer, stats] = await Promise.all([readFile(iconPath), stat(iconPath)]);
      return c.body(buffer, 200, {
        "Content-Type": mime,
        "Content-Length": String(stats.size),
        "Content-Disposition": "attachment",
        "Cache-Control": "public, max-age=300",
      });
    } catch {
      return c.json({ error: `Icon for app "${appId}" not found on disk` }, 404);
    }
  });

  // The README.md packed at the bundle root (packaging/pack.ts copies it out
  // of the workspace root). Advisory content for the dashboard's app details
  // page: a bundle without a README, or an unresolved view (disabled / failed
  // install, no rootPath), degrades to `readme: null` rather than an error —
  // only "not installed" 404s.
  //
  // Deliberately NOT `/apps/:appId/readme`: every sub-path of `/apps/:appId/`
  // that isn't already reserved (icon, manifest, …) belongs to the app's own
  // API surface — the app-web SDK maps `fetchAppApi("readme")` there, and a
  // static handler here would shadow it for every installed app. Host-owned
  // metadata gets its own namespace instead (like `/app-assets/`).
  app.get("/app-readmes/:appId", async (c) => {
    const appId = c.req.param("appId");
    try {
      assertValidAppId(appId);
    } catch {
      return c.json({ error: "Invalid app id" }, 400);
    }
    const view = deps.appCatalog.get(appId);
    if (!view) {
      return c.json({ error: `App "${appId}" is not installed` }, 404);
    }
    const response: AppReadmeResponse = { appId, readme: null };
    if (isResolvedApp(view)) {
      try {
        response.readme = await readFile(join(view.rootPath, "README.md"), "utf-8");
      } catch {
        // No README in the bundle — stay null.
      }
    }
    return c.json(response);
  });

  app.get("/apps", async (c) => {
    const catalog = deps.appCatalog;
    const views = catalog.list();
    const publicAccess = await loadPublicAccessConfig(deps);
    const artifactDetailsByApp = await loadArtifactDetailsByApp(catalog);
    const cards = views.map((view) =>
      toInstalledAppCard(
        view,
        publicAccess,
        artifactDetailsByApp.get(view.appId) ?? emptyArtifactDetails(),
      ),
    );

    const response: AppListResponse = { apps: rankSourceInstalledAppsFirst(cards) };
    return c.json(response);
  });

  app.get("/apps/:appId/manifest", async (c) => {
    const appId = c.req.param("appId");
    const mode = c.req.query("mode") === "full" ? "full" : "embedded";
    const path = c.req.query("path") ?? "";

    const view = deps.appCatalog.get(appId);
    if (!view || !isResolvedApp(view) || !view.web) {
      return c.json({ error: `App "${appId}" has no frontend` }, 404);
    }

    const appIdSegment = appIdToPathSegment(appId);
    const routeBase = mode === "full" ? getFullAppHref(appId) : getEmbeddedAppHref(appId);
    const assetBase = `/app-assets/${appIdSegment}/${view.web.assetVersion}`;
    const [publicAccess, guardianSession] = await Promise.all([
      loadPublicAccessConfig(deps),
      resolveGuardianSession(c, deps.db),
    ]);
    const cloudAllowedEmails = publicAccess.cloudEmailAccess[appId] ?? [];
    const accessMode: AppAccessMode = publicAccess.allowedApps.includes(appId)
      ? "public"
      : cloudAllowedEmails.length > 0
        ? "cloud-email"
        : "private";
    const viewer = resolveVisitorSession(c);
    const guardianAccessAllowed = guardianSession !== null;
    const dashboardAccessAllowed =
      viewer !== null && deps.dashboardAccessState.isCloudEmailAllowed(viewer.email);
    const callerAccessAllowed =
      accessMode !== "cloud-email" ||
      guardianAccessAllowed ||
      dashboardAccessAllowed ||
      (viewer !== null && cloudAllowedEmails.includes(viewer.email.toLowerCase()));
    // Client-side mirror of the server-side `request.caller` (apps/api.ts):
    // resolved here, per manifest fetch, and delivered on the bootstrap so the
    // app UI can gate owner-only affordances without probing a route. Advisory
    // only — enforcement stays in the app's API handler.
    const guardianActor = guardianSession
      ? await enrichGuardianActor(deps.db, guardianSession)
      : null;
    const caller =
      guardianSession !== null
        ? ({
            kind: "guardian",
            userId: guardianSession.userId,
            ...(guardianActor?.kind === "guardian" && guardianActor.email
              ? { email: guardianActor.email }
              : {}),
          } as const)
        : viewer !== null
          ? ({ kind: "visitor", accountId: viewer.accountId, email: viewer.email } as const)
          : ({ kind: "anonymous" } as const);
    return c.json({
      appId,
      appName: view.web.displayName,
      isPublic: accessMode !== "private",
      accessMode,
      guardianAccessAllowed,
      dashboardAccessAllowed,
      callerAccessAllowed,
      entryUrl: `${assetBase}/${view.web.entry}`,
      styleUrls: view.web.styles.map((stylePath) => `${assetBase}/${stylePath}`),
      bootstrap: {
        appId,
        version: view.manifest.version,
        routeBase,
        routePath: path,
        apiBase: `/api/apps/${appIdSegment}`,
        assetBase,
        shell: { theme: "light", themeName: "ember", mode },
        // `caller` rides the bootstrap (not globalParams) deliberately: it is
        // fixed per mount — identity changes only via a full-page login
        // redirect, which remounts — while globalParams is a live host channel
        // whose replace-on-push semantics would wipe identity fields.
        caller,
        globalParams: {},
      },
    });
  });

  app.delete("/apps/:appId", async (c) => {
    const appId = c.req.param("appId");
    try {
      assertValidAppId(appId);
    } catch {
      return c.json({ error: "Invalid app id" }, 400);
    }
    const systemBlock = assertAppIdIsNotSystem(c, appId, 'App "system" cannot be uninstalled');
    if (systemBlock) return systemBlock;
    const body = await c.req.json<{ purge?: boolean }>().catch(() => ({}) as { purge?: boolean });
    const appsRoot = deps.appsRoot ?? getProfileAppsDir();
    const wantsPurge = body.purge === true;
    try {
      let tablePrefix: string | null = null;
      if (wantsPurge) {
        tablePrefix = await resolveTablePrefixForPurge({
          appId,
          appsRoot,
          catalog: deps.appCatalog,
        });
      }
      const result = await deps.appManager.uninstall(appId, { purge: wantsPurge });
      if (result.alreadyAbsent) {
        return c.json({ appId, purged: wantsPurge });
      }
      if (wantsPurge) {
        await purgeAppUserData({
          appId,
          tablePrefix,
          db: deps.db,
          appsRoot,
        });
      }
      return c.json({ appId, purged: wantsPurge });
    } catch (err) {
      return appManagerErrorResponse(c, err);
    }
  });

  // The appId is derived by the daemon from the source (manifest id for local
  // sources, canonical listing id for appstore) and returned in the response. The
  // system app is re-installable here (this is how it upgrades to a newer
  // packed artifact); AppManager.install rejects only an attempt to install
  // it disabled.
  app.post("/apps", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body: expected JSON" }, 400);
    }
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json({ error: "Invalid request body: expected JSON object" }, 400);
    }
    const body = rawBody as Record<string, unknown>;
    let parsedSource: SpecSource | undefined;
    if (body.source !== undefined) {
      const parsed = SpecSourceSchema.safeParse(body.source);
      if (!parsed.success) {
        return c.json(
          {
            error: `Invalid deployment source: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`,
          },
          400,
        );
      }
      parsedSource = parsed.data;
    }
    let parsedEnabled: boolean | undefined;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return c.json({ error: "Invalid request body: enabled must be a boolean" }, 400);
      }
      parsedEnabled = body.enabled;
    }
    if (!parsedSource) {
      return c.json(
        {
          error:
            `POST /apps: body.source is required — the daemon does not infer source from the lockfile. ` +
            `For a local app pass { mode: "source", path: "<app repo>" } — the daemon builds, packs, and installs. ` +
            `Pass { mode: "bundle", path } only for an already-packed artifact dir. ` +
            `To flip enabled without re-installing, use PATCH /apps/:appId instead.`,
        },
        400,
      );
    }
    try {
      const result = await deps.appManager.install({
        source: parsedSource,
        enabled: parsedEnabled,
      });
      const view = deps.appCatalog.get(result.appId);
      const response: AppInstallResponse = {
        appId: result.appId,
        spec: { source: parsedSource, enabled: parsedEnabled ?? view?.enabled ?? true },
        phase: result.state,
        ...(result.error ? { error: result.error.message } : {}),
      };
      return c.json(response);
    } catch (err) {
      return appManagerErrorResponse(c, err);
    }
  });

  // Scoped to `enabled` only; use this (not PUT) to flip enabled state
  // without re-installing.
  app.patch("/apps/:appId", async (c) => {
    const appId = c.req.param("appId");
    try {
      assertValidAppId(appId);
    } catch {
      return c.json({ error: "Invalid app id" }, 400);
    }
    const systemBlock = assertAppIdIsNotSystem(c, appId, 'App "system" cannot be modified');
    if (systemBlock) return systemBlock;
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body: expected JSON" }, 400);
    }
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json({ error: "Invalid request body: expected JSON object" }, 400);
    }
    const body = rawBody as Record<string, unknown>;
    if (body.enabled === undefined) {
      return c.json(
        {
          error: "PATCH /apps/:appId requires `enabled` (boolean) — no other fields are patchable",
        },
        400,
      );
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "Invalid request body: enabled must be a boolean" }, 400);
    }
    const unknownKeys = Object.keys(body).filter((k) => k !== "enabled");
    if (unknownKeys.length > 0) {
      return c.json(
        {
          error: `PATCH /apps/:appId only accepts \`enabled\` — unknown fields: ${unknownKeys.join(", ")}`,
        },
        400,
      );
    }
    try {
      await deps.appManager.setEnabled(appId, body.enabled);
      const view = deps.appCatalog.get(appId);
      if (!view) {
        throw new Error(`Invariant: app "${appId}" missing from catalog after setEnabled`);
      }
      const response: AppInstallResponse = {
        appId,
        spec: { source: view.source, enabled: view.enabled },
        phase: view.state,
        ...(view.lastError ? { error: view.lastError.message } : {}),
      };
      return c.json(response);
    } catch (err) {
      return appManagerErrorResponse(c, err);
    }
  });

  // Repacks the installed bundle and publishes it to the Rome App Store,
  // authenticated by this instance's token. Version and handle policy are
  // enforced by the store; its rejection messages pass through verbatim with
  // their status so the dashboard can surface them.
  app.post("/apps/:appId/publish", async (c) => {
    const appId = c.req.param("appId");
    try {
      assertValidAppId(appId);
    } catch {
      return c.json({ error: "Invalid app id" }, 400);
    }
    const systemBlock = assertAppIdIsNotSystem(c, appId, 'App "system" cannot be published');
    if (systemBlock) return systemBlock;
    if (!deps.appCatalog) {
      return c.json({ error: "App catalog is not configured" }, 501);
    }
    const view = deps.appCatalog.get(appId);
    if (!view) {
      return c.json({ error: `App "${appId}" is not installed` }, 404);
    }
    if (view.state !== "installed") {
      return c.json({ error: `App "${appId}" is ${view.state}; cannot publish` }, 409);
    }
    const artifactRoot = publishArtifactRoot(view.source);
    if (artifactRoot == null || !isPublishableSource(appId, view.source)) {
      return c.json(
        {
          error: `App "${appId}" was not developed on this instance; only locally developed apps can be published`,
        },
        409,
      );
    }
    if (view.installedHash == null) {
      return c.json(
        { error: `App "${appId}" has no pinned install hash; re-install before publishing` },
        409,
      );
    }
    // Publish the pinned source artifact (verified against installedHash
    // inside publishAppBundle), never the materialized install dir — see the
    // module doc in apps/publish.ts. This also keeps disabled apps
    // publishable: nothing here requires runtime resolution.
    const result = await publishAppBundle(artifactRoot, view.installedHash);
    switch (result.status) {
      case "ok": {
        const response: AppPublishResponse = {
          appId,
          listing: result.listing,
          version: result.version,
          claimed: result.claimed,
        };
        return c.json(response, 201);
      }
      case "artifact_missing":
        return c.json(
          {
            error: `The source artifact for "${appId}" is no longer at ${artifactRoot}; re-install it before publishing`,
          },
          409,
        );
      case "artifact_drifted":
        return c.json(
          {
            error: `The source artifact for "${appId}" has changed since it was installed; install it again before publishing`,
          },
          409,
        );
      case "no_token":
        return c.json(
          {
            error:
              "This Rome instance is not connected to a Rome account, so it cannot publish to the App Store.",
          },
          412,
        );
      case "auth_invalid":
        return c.json(
          {
            error:
              "The App Store no longer accepts this Rome instance's credentials. Reconnect this instance to its Rome account and try again.",
          },
          403,
        );
      case "unconfigured":
        return c.json({ error: "App Store origin is not configured for this instance" }, 501);
      case "unreachable":
        return c.json({ error: `Could not reach the App Store: ${result.message}` }, 502);
      case "rejected": {
        // Client-class refusals (auth, version policy, size cap) keep their
        // status; an upstream 5xx is our gateway failure, not the caller's.
        const status =
          result.httpStatus >= 400 && result.httpStatus < 500 ? result.httpStatus : 502;
        return c.json({ error: result.message }, status as ContentfulStatusCode);
      }
    }
  });

  app.get("/apps/:appId", async (c) => {
    const appId = c.req.param("appId");
    try {
      assertValidAppId(appId);
    } catch {
      return c.json({ error: "Invalid app id" }, 400);
    }
    const view = deps.appCatalog.get(appId);
    if (!view) {
      return c.json({ error: `App "${appId}" is not installed` }, 404);
    }
    const response: AppDetailResponse = {
      spec: { source: view.source, enabled: view.enabled },
      phase: view.state,
      ...(view.lastError ? { error: view.lastError.message } : {}),
    };
    return c.json(response);
  });

  return app;
}
