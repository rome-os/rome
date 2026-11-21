import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { createRomeCloudOAuthStartUrl } from "../../connections/oauth/rome-cloud-oauth.js";
import {
  ensureWebchatProjectWorkspace,
  getWebchatProjectsRoot,
  normalizeWebchatProjectPath,
  resolveWebchatProjectPath,
} from "../../webchat/projects.js";
import {
  deleteProjectSyncLink,
  getProjectSyncLink,
  updateProjectSyncLinkExtra,
  upsertProjectSyncLink,
} from "../../db/repositories/project-sync-links.js";
import { getSyncSource, listSyncSourceDescriptors } from "../../sync/registry.js";
import { withMemoryGitLock } from "../../sync/memory-git-lock.js";
import { getProfileMemoryDir } from "../../paths.js";
import type { LinkStrategy, RemoteTarget } from "../../sync/types.js";
import type { ApiDeps } from "../deps.js";

/**
 * Reserved sync key for the guardian's memory directory. Memory rides
 * the same source/table/routes as projects, but resolves to `memory/` instead of
 * a webchat project path; the `@` prefix can never be produced by
 * `normalizeWebchatProjectPath`, so it can't collide with a real project.
 */
const MEMORY_SYNC_KEY = "@memory";

/**
 * Project ↔ external-source sync. Every handler is parameterized by
 * `projectPath` + `source` and forwards to the registered `SyncSource`. The
 * route carries no git/GitHub knowledge — pure dispatch.
 */
export function syncRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  async function resolveProjectDir(projectPath: string): Promise<string> {
    const normalized = normalizeWebchatProjectPath(projectPath);
    const root = getWebchatProjectsRoot();
    await ensureWebchatProjectWorkspace(normalized, root);
    return resolveWebchatProjectPath(normalized, root);
  }

  const isMemoryKey = (projectPath: string): boolean => projectPath === MEMORY_SYNC_KEY;

  function normalizeSyncKey(projectPath: string): string {
    return isMemoryKey(projectPath) ? MEMORY_SYNC_KEY : normalizeWebchatProjectPath(projectPath);
  }

  async function resolveSyncDir(projectPath: string): Promise<string> {
    return isMemoryKey(projectPath) ? getProfileMemoryDir() : resolveProjectDir(projectPath);
  }

  /** Serialize memory writes against the file-save auto-commit;
   * project syncs run directly. */
  function withSyncLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    return isMemoryKey(projectPath) ? withMemoryGitLock(fn) : fn();
  }

  // List sources + their availability. Drives the connect component's first step.
  app.get("/sync/sources", async (c) => {
    const db = deps.db;

    const descriptors = listSyncSourceDescriptors();
    const sources = await Promise.all(
      descriptors.map(async (descriptor) => {
        const source = getSyncSource(db, descriptor.id);
        const availability = source ? await source.availability() : { available: false };
        let connectUrl = availability.connectUrl ?? null;
        if (!availability.available && descriptor.authProvider) {
          const connect = createRomeCloudOAuthStartUrl(descriptor.authProvider);
          connectUrl = connect.connectUrl;
        }
        return { ...descriptor, ...availability, connectUrl };
      }),
    );

    c.header("Cache-Control", "no-store");
    return c.json({ sources });
  });

  app.get("/sync/groups", async (c) => {
    const db = deps.db;

    const sourceId = c.req.query("source") ?? "";
    const source = getSyncSource(db, sourceId);
    if (!source) return c.json({ error: "Unknown source" }, 404);
    if (!source.listGroups) return c.json({ groups: [] });

    try {
      const groups = await source.listGroups();
      c.header("Cache-Control", "no-store");
      return c.json({ groups });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to list groups" }, 502);
    }
  });

  app.get("/sync/targets", async (c) => {
    const db = deps.db;

    const sourceId = c.req.query("source") ?? "";
    const query = c.req.query("q") ?? undefined;
    const source = getSyncSource(db, sourceId);
    if (!source) return c.json({ error: "Unknown source" }, 404);

    try {
      const targets = await source.listTargets(query);
      c.header("Cache-Control", "no-store");
      return c.json({ targets });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to list targets" }, 502);
    }
  });

  app.post("/sync/targets", async (c) => {
    const db = deps.db;
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const body = await c.req
      .json<{
        source?: string;
        name?: string;
        group?: string;
        private?: boolean;
        description?: string;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const source = getSyncSource(db, body.source ?? "");
    if (!source) return c.json({ error: "Unknown source" }, 404);
    if (!body.name?.trim()) return c.json({ error: "A name is required" }, 400);

    try {
      const target = await source.createTarget({
        name: body.name.trim(),
        group: body.group,
        private: body.private,
        description: body.description,
      });
      return c.json({ target }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to create target" }, 502);
    }
  });

  app.post("/sync/link", async (c) => {
    const db = deps.db;
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const body = await c.req
      .json<{
        projectPath?: string;
        source?: string;
        target?: RemoteTarget;
        strategy?: LinkStrategy;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const source = getSyncSource(db, body.source ?? "");
    if (!source) return c.json({ error: "Unknown source" }, 404);
    if (!body.projectPath || !body.target) {
      return c.json({ error: "projectPath and target are required" }, 400);
    }

    try {
      const dir = await resolveSyncDir(body.projectPath);
      const normalized = normalizeSyncKey(body.projectPath);
      const target = body.target;
      const strategy = body.strategy ?? "auto";
      const outcome = await withSyncLock(body.projectPath, () =>
        source.link(dir, target, strategy),
      );
      await upsertProjectSyncLink(db, {
        projectPath: normalized,
        linkType: source.id,
        extra: outcome.extra,
      });
      return c.json({
        ...outcome.status,
        sourceId: source.id,
        resolvedCase: outcome.resolvedCase,
        remoteLabel: outcome.status.remoteLabel ?? body.target.label,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to link" }, 409);
    }
  });

  app.post("/sync/unlink", async (c) => {
    const db = deps.db;
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const body = await c.req
      .json<{ projectPath?: string }>()
      .catch(() => ({}) as { projectPath?: string });
    if (!body.projectPath) return c.json({ error: "projectPath is required" }, 400);

    const normalized = normalizeSyncKey(body.projectPath);
    const link = await getProjectSyncLink(db, normalized);
    if (link) {
      const source = getSyncSource(db, link.linkType);
      if (source) {
        const dir = await resolveSyncDir(normalized);
        await source.unlink(dir).catch(() => undefined);
      }
      await deleteProjectSyncLink(db, normalized);
    }
    return c.json({ ok: true });
  });

  app.get("/sync/status", async (c) => {
    const db = deps.db;

    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath is required" }, 400);

    const normalized = normalizeSyncKey(projectPath);
    const link = await getProjectSyncLink(db, normalized);
    c.header("Cache-Control", "no-store");
    if (!link) return c.json({ state: "unlinked" });

    const source = getSyncSource(db, link.linkType);
    if (!source) return c.json({ state: "error", message: "Source unavailable" });

    try {
      const dir = await resolveSyncDir(normalized);
      const status = await source.status(dir, link.extra);
      return c.json({ ...status, sourceId: link.linkType });
    } catch (err) {
      return c.json({
        state: "error",
        message: err instanceof Error ? err.message : "Status failed",
      });
    }
  });

  app.get("/sync/changes", async (c) => {
    const db = deps.db;

    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath is required" }, 400);

    const normalized = normalizeSyncKey(projectPath);
    const link = await getProjectSyncLink(db, normalized);
    c.header("Cache-Control", "no-store");
    if (!link) return c.json({ files: [] });

    const source = getSyncSource(db, link.linkType);
    // A source with no change enumeration (or an unavailable one) yields an empty
    // list — the drill-down just shows nothing rather than erroring.
    if (!source?.listChanges) return c.json({ files: [] });

    try {
      const dir = await resolveSyncDir(normalized);
      const files = await source.listChanges(dir, link.extra);
      return c.json({ files });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to list changes" }, 502);
    }
  });

  app.get("/sync/changes/diff", async (c) => {
    const db = deps.db;
    const projectPath = c.req.query("projectPath");
    const changePath = c.req.query("path");
    if (!projectPath || !changePath) {
      return c.json({ error: "projectPath and path are required" }, 400);
    }

    const normalized = normalizeSyncKey(projectPath);
    const link = await getProjectSyncLink(db, normalized);
    c.header("Cache-Control", "no-store");
    if (!link) return c.json({ error: "Project is not linked" }, 404);

    const source = getSyncSource(db, link.linkType);
    const getChangeDiff = source?.getChangeDiff?.bind(source);
    if (!getChangeDiff) {
      return c.json({ error: "This sync source cannot show file diffs" }, 501);
    }

    try {
      const dir = await resolveSyncDir(normalized);
      return c.json(await getChangeDiff(dir, changePath, link.extra));
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to load file diff" },
        409,
      );
    }
  });

  app.post("/sync/changes/restore", async (c) => {
    const db = deps.db;
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const body = await c.req
      .json<{ projectPath?: string; path?: string }>()
      .catch(() => ({}) as { projectPath?: string; path?: string });
    if (!body.projectPath || !body.path) {
      return c.json({ error: "projectPath and path are required" }, 400);
    }
    const projectPath = body.projectPath;
    const changePath = body.path;

    const normalized = normalizeSyncKey(projectPath);
    const link = await getProjectSyncLink(db, normalized);
    if (!link) return c.json({ error: "Project is not linked" }, 404);

    const source = getSyncSource(db, link.linkType);
    if (!source) return c.json({ error: "Source unavailable" }, 404);
    const restoreChange = source.restoreChange?.bind(source);
    if (!restoreChange) {
      return c.json({ error: "This sync source cannot undo individual files" }, 501);
    }

    try {
      const dir = await resolveSyncDir(normalized);
      await withSyncLock(normalized, () => restoreChange(dir, changePath, link.extra));
      const files = source.listChanges ? await source.listChanges(dir, link.extra) : [];
      return c.json({ files });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to undo change" }, 409);
    }
  });

  app.post("/sync/changes/restore-all", async (c) => {
    const db = deps.db;
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const body = await c.req
      .json<{ projectPath?: string }>()
      .catch(() => ({}) as { projectPath?: string });
    if (!body.projectPath) return c.json({ error: "projectPath is required" }, 400);

    const normalized = normalizeSyncKey(body.projectPath);
    const link = await getProjectSyncLink(db, normalized);
    if (!link) return c.json({ error: "Project is not linked" }, 404);

    const source = getSyncSource(db, link.linkType);
    if (!source) return c.json({ error: "Source unavailable" }, 404);
    const restoreAllChanges = source.restoreAllChanges?.bind(source);
    if (!restoreAllChanges) {
      return c.json({ error: "This sync source cannot undo all files" }, 501);
    }

    try {
      const dir = await resolveSyncDir(normalized);
      await withSyncLock(normalized, () => restoreAllChanges(dir, link.extra));
      const files = source.listChanges ? await source.listChanges(dir, link.extra) : [];
      return c.json({ files });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to undo all changes" },
        409,
      );
    }
  });

  app.post("/sync/reset", async (c) => {
    const db = deps.db;
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const body = await c.req
      .json<{ projectPath?: string }>()
      .catch(() => ({}) as { projectPath?: string });
    if (!body.projectPath) return c.json({ error: "projectPath is required" }, 400);

    const normalized = normalizeSyncKey(body.projectPath);
    const link = await getProjectSyncLink(db, normalized);
    if (!link) return c.json({ error: "Project is not linked" }, 404);

    const source = getSyncSource(db, link.linkType);
    if (!source) return c.json({ error: "Source unavailable" }, 404);
    const resetToDefault = source.resetToDefault?.bind(source);
    if (!resetToDefault) {
      return c.json({ error: "This sync source cannot reset its ref" }, 501);
    }

    try {
      const dir = await resolveSyncDir(normalized);
      const status = await withSyncLock(normalized, () => resetToDefault(dir, link.extra));
      return c.json({ ...status, sourceId: link.linkType });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Reset failed" }, 409);
    }
  });

  app.post("/sync/sync", async (c) => {
    const db = deps.db;
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const body = await c.req
      .json<{ projectPath?: string; direction?: "push" | "pull" | "both" }>()
      .catch(() => ({}) as { projectPath?: string; direction?: "push" | "pull" | "both" });
    if (!body.projectPath) return c.json({ error: "projectPath is required" }, 400);

    const normalized = normalizeSyncKey(body.projectPath);
    const link = await getProjectSyncLink(db, normalized);
    if (!link) return c.json({ error: "Project is not linked" }, 404);

    const source = getSyncSource(db, link.linkType);
    if (!source) return c.json({ error: "Source unavailable" }, 404);

    try {
      const dir = await resolveSyncDir(normalized);
      const direction = body.direction ?? "both";
      // The source returns possibly-updated `extra` (refreshed visibility, sync
      // time); persist it so later status reads reflect it.
      const outcome = await withSyncLock(normalized, () => source.sync(dir, direction, link.extra));
      await updateProjectSyncLinkExtra(db, normalized, outcome.extra);
      return c.json({ ...outcome.status, sourceId: link.linkType });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Sync failed" }, 502);
    }
  });

  return app;
}
