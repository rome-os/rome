import { Hono, type Handler } from "hono";
import {
  createAssetHandler,
  createDownloadHandler,
  createFileGetHandler,
  createResolveHandler,
  createSearchHandler,
  createTreeHandler,
  type FileBrowserScope,
} from "../../lib/file-browser-server.js";
import { ensureProjectsRootInitialized } from "../../paths.js";
import { PROJECT_FILE_BROWSER_POLICY } from "../../lib/project-file-browser.js";
import { resolveWebchatProjectPath } from "../../webchat/projects.js";
import { createLogger } from "../../logger.js";
import type { StoredSharedChat } from "../../db/repositories/webchat.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:share");

/**
 * Public, login-free surface for shared chats. The auth edge waves through
 * `/api/share/*` (see `PUBLIC_API_PATHS`); the bearer token in the path is the
 * only credential, so every handler resolves the share first and 404s when it's
 * missing or revoked. Share *management* (create/list/revoke) lives under
 * `/chat/...` in webchat.ts so it stays behind the cookie gate.
 */
export function shareRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const projectsRoot = ensureProjectsRootInitialized();

  // Read-only snapshot: returns the frozen chat + widget layout for the token.
  app.get("/share/:token", async (c) => {
    const token = c.req.param("token");
    const share = await deps.webchatRepo.getSharedChat(token);
    if (!share) return c.json({ error: "Share not found" }, 404);

    let snapshot: unknown;
    let layout: unknown;
    try {
      snapshot = JSON.parse(share.snapshot);
      layout = JSON.parse(share.layout);
    } catch (err) {
      log.error("shared_chat_parse_failed", { token, error: String(err) });
      return c.json({ error: "Corrupt share" }, 500);
    }
    return c.json({ id: share.id, title: share.title, snapshot, layout });
  });

  // Whether a frozen layout actually shared a projects tile. A chat-only share
  // must NOT expose `/projects/*` just because its token is live, so the gate is
  // the layout's content, not merely a valid token.
  const layoutHasProjectsWidget = (rawLayout: string): boolean => {
    try {
      const layout = JSON.parse(rawLayout);
      return (
        Array.isArray(layout) &&
        layout.some(
          (item) =>
            item && typeof item === "object" && (item as { type?: unknown }).type === "projects",
        )
      );
    } catch {
      return false;
    }
  };

  // The project dir this share is scoped to, or null if it can't/shouldn't serve
  // files (revoked, no projects tile, or no/invalid stored project path). A
  // non-null result is guaranteed to sit inside the projects root.
  const projectRootForShare = (share: StoredSharedChat): string | null => {
    if (!share.projectPath || !layoutHasProjectsWidget(share.layout)) return null;
    try {
      // resolveWebchatProjectPath normalizes and rejects traversal (`..`,
      // absolute, backslash), so the result can never escape the projects root.
      return resolveWebchatProjectPath(share.projectPath, projectsRoot);
    } catch {
      return null;
    }
  };

  // Scope is per-request so asset URLs embed the request's own token. logicalRoot
  // stays "projects" while rootDir is the project dir, so the frozen layout's
  // project-relative `selectedPath` (rewritten at share time) stays addressable.
  const scopeFor = (token: string, rootDir: string): FileBrowserScope => ({
    ...PROJECT_FILE_BROWSER_POLICY,
    assetBasePath: `/api/share/${encodeURIComponent(token)}/projects/asset`,
    logicalRoot: "projects",
    rootDir,
  });

  // Read-only projects file browser, token-gated AND project-scoped: every
  // request resolves the share, 404s unless it's live with a projects tile and a
  // valid project, then roots the browser at that one project dir — so a link
  // exposes that project's files read-only, never the whole projects root.
  const readHandler =
    (make: (scope: FileBrowserScope) => Handler): Handler =>
    async (c, next) => {
      const token = c.req.param("token") ?? "";
      const share = token ? await deps.webchatRepo.getSharedChat(token) : null;
      const rootDir = share ? projectRootForShare(share) : null;
      if (!rootDir) return c.json({ error: "Share not found" }, 404);
      return make(scopeFor(token, rootDir))(c, next);
    };

  app.get("/share/:token/projects/tree", readHandler(createTreeHandler));
  app.get("/share/:token/projects/resolve", readHandler(createResolveHandler));
  app.get("/share/:token/projects/file", readHandler(createFileGetHandler));
  app.get("/share/:token/projects/asset", readHandler(createAssetHandler));
  app.get("/share/:token/projects/asset/:fileName", readHandler(createAssetHandler));
  app.get("/share/:token/projects/download", readHandler(createDownloadHandler));
  app.get("/share/:token/projects/search", readHandler(createSearchHandler));

  return app;
}
