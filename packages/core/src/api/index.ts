import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createLogger } from "../logger.js";
import { renderSocialMeta } from "../lib/social-meta.js";
import { buildAppSocialCard } from "./app-social-card.js";
import { attachTerminalServer } from "../terminal-server.js";
import { attachDesktopProxy } from "../desktop-proxy-server.js";
import { attachAppWebSocket } from "../apps/websocket-server.js";
import { errorHandler } from "./middleware/error-handler.js";
import { defaultApiCacheControl } from "./middleware/cache-control.js";
import { sessionActorMiddleware } from "../lib/session-actor.js";
import { healthRoutes } from "./routes/health.js";
import { aiToolsRoutes } from "./routes/ai-tools.js";
import { actionsRoutes } from "./routes/actions.js";
import { appsRoutes } from "./routes/apps.js";
import { agentsRoutes } from "./routes/agents.js";
import { skillsRoutes } from "./routes/skills.js";
import { discordCliRoutes } from "./routes/discord-cli.js";
import { conversationSettingsRoutes } from "./routes/conversation-settings.js";
import { connectionsRoutes } from "./routes/connections.js";
import { setupsRoutes } from "./routes/setups.js";
import { approvalsRoutes } from "./routes/approvals.js";
import { appApiDashboardRoutes, appApiPublicRoutes } from "./routes/app-api.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { createWebchatRuntime, type WebchatRuntime } from "./routes/webchat.js";
import { settingsRoutes } from "./routes/settings.js";
import { appKeysRoutes } from "./routes/app-keys.js";
import { uptimeRoutes } from "./routes/uptime.js";
import { buildInfoRoutes } from "./routes/build-info.js";
import { diagnosisRoutes } from "./routes/diagnosis.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { systemUpgradeRoutes } from "./routes/system-upgrade.js";
import { accountsRoutes } from "./routes/accounts.js";
import { accountDecisionRoutes } from "./routes/account-decisions.js";
import { peopleRoutes } from "./routes/people.js";
import { whatsappContactsRoutes } from "./routes/whatsapp-contacts.js";
import { sentinelLogRoutes } from "./routes/sentinel-log.js";
import { webhookInvocationsRoutes } from "./routes/webhook-invocations.js";
import { actionExecutionsRoutes } from "./routes/action-executions.js";
import { terminalRoutes } from "./routes/terminal.js";
import {
  capabilityDiscoveryRoutes,
  hostCapabilityDiscoverySource,
} from "./routes/capability-discovery.js";
import { desktopRoutes } from "./routes/desktop.js";
import { tailscaleRoutes } from "./routes/tailscale.js";
import { authRoutes } from "./routes/auth.js";
import { onboardRoutes } from "./routes/onboard.js";
import { instanceEnrollRoutes } from "./routes/instance-enroll.js";
import { cloudLoginRoutes } from "./routes/cloud-login.js";
import { visitorAuthRoutes } from "./routes/visitor-auth.js";
import { oauthRoutes } from "./routes/oauth.js";
import { integrationsRoutes } from "./routes/integrations.js";
import { memoryFilesRoutes } from "./routes/memory-files.js";
import { projectsFilesRoutes } from "./routes/projects-files.js";
import { syncRoutes } from "./routes/sync.js";
import { publicAccessRoutes } from "./routes/public-access.js";
import { dashboardAccessRoutes } from "./routes/dashboard-access.js";
import { desktopProxyRoutes } from "./routes/desktop-proxy.js";
import { appAssetsRoutes } from "./routes/app-assets.js";
import { appOgRoutes } from "./routes/app-og.js";
import { appStoreRoutes } from "./routes/app-store.js";
import { showcasePresetRoutes } from "./routes/showcase-presets.js";
import { shareRoutes } from "./routes/share.js";
import { routinesRoutes } from "./routes/routines.js";
import { eventCatalogRoutes } from "./routes/event-catalog.js";
import { favorRoutes } from "./routes/favors.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { SessionQueryRepository } from "../db/repositories/session-query.js";
import { SessionQueryService } from "../sessions/query-service.js";
import type { ApiConfig, ApiDeps, ApiHandle } from "./deps.js";

const log = createLogger("api");

export function buildApp(
  deps: ApiDeps,
  config: ApiConfig,
): { app: Hono; webchatRuntime: WebchatRuntime } {
  const app = new Hono();
  app.onError(errorHandler);

  // Same-container Agent surface. This is deliberately outside `/api`, which
  // is Caddy-proxied, and refuses to register on a non-loopback listener.
  app.route("/", discordCliRoutes(deps, config.host));

  // External webhooks — X-API-Key auth, no /api/ prefix. Intentionally outside
  // sessionActorMiddleware: a machine-credential surface records no session
  // actor (the router also enforces this itself via withoutSessionActor).
  app.route("/", webhookRoutes(deps, config.webhookApiKey));

  // noVNC reverse proxy — mounted at root so the dashboard iframe can embed
  // the desktop on the same origin. WebSocket upgrades are handled separately
  // via attachDesktopProxy() on the raw HTTP server.
  app.route("/", desktopProxyRoutes());

  // Built web assets for installed apps, served at /app-assets/:appId/:version/*.
  app.route("/", appAssetsRoutes(deps));

  // Social card image per installed app, at /app-og/<appId>.png (public).
  app.route("/", appOgRoutes(deps));

  // Internal dashboard/app routes — mounted under /api. No global auth gate
  // here on purpose: the Hono server binds to loopback (`INTERNAL_API_HOST`),
  // so the only callers are (1) internal Rome processes inside the container
  // and (2) Caddy after `forward_auth` clears the request at the public edge.
  // A Rome instance is single-tenant by design, so route handlers do not need
  // to derive a userId — the instance itself is the user. See
  // `scripts/generate-caddyfile.ts` for the edge-side enforcement.
  const api = new Hono();

  // Dynamic API responses are mutable single-tenant state; default them to
  // `Cache-Control: no-store` unless a route sets its own policy. Registered
  // first so its post-handler pass runs last and can see the final headers.
  api.use("*", defaultApiCacheControl());

  // Annotate-only (never gates): expose the request's session actor ambiently
  // so any action run during the request is stamped with who triggered it —
  // see lib/session-actor.ts and `action_executions.actor`.
  api.use("*", sessionActorMiddleware(deps.db));

  api.route("/", healthRoutes(deps));
  api.route("/", uptimeRoutes());
  api.route("/", buildInfoRoutes(deps));
  api.route("/", diagnosisRoutes(deps));
  api.route("/", feedbackRoutes(deps));
  api.route("/", systemUpgradeRoutes(deps));
  api.route("/", authRoutes(deps));
  api.route("/", onboardRoutes(deps));
  api.route("/", instanceEnrollRoutes(deps));
  api.route("/", cloudLoginRoutes(deps));
  api.route("/", visitorAuthRoutes(deps));
  api.route("/", oauthRoutes(deps));
  api.route("/", appApiPublicRoutes(deps));
  api.route("/", integrationsRoutes(deps));
  api.route("/", connectionsRoutes(deps));
  api.route("/", setupsRoutes(deps));
  api.route("/", capabilityDiscoveryRoutes(hostCapabilityDiscoverySource));
  api.route("/", desktopRoutes());
  api.route("/", publicAccessRoutes(deps));
  api.route("/", dashboardAccessRoutes(deps));
  api.route("/", aiToolsRoutes(deps));
  api.route("/", actionsRoutes(deps));
  api.route("/", appsRoutes(deps));
  api.route("/", agentsRoutes(deps));
  api.route("/", skillsRoutes(deps));
  // Mounted AFTER `appsRoutes` so its static `/apps/:appId/{icon,manifest,...}`
  // handlers win for their reserved sub-paths; everything else falls through
  // to the app's API entrypoint.
  api.route("/", appApiDashboardRoutes(deps));
  api.route("/", appStoreRoutes(deps.appStore));
  api.route("/", showcasePresetRoutes());
  api.route("/", favorRoutes(deps));
  api.route("/", conversationSettingsRoutes(deps));
  api.route("/", approvalsRoutes(deps));
  api.route("/", settingsRoutes(deps));
  api.route("/", appKeysRoutes(deps));
  api.route("/", routinesRoutes(deps));
  api.route("/", eventCatalogRoutes(deps));
  api.route("/", peopleRoutes(deps));
  api.route("/", accountsRoutes(deps));
  api.route("/", accountDecisionRoutes(deps));
  api.route("/", whatsappContactsRoutes(deps));
  api.route("/", sentinelLogRoutes(deps));
  api.route("/", webhookInvocationsRoutes(deps));
  api.route("/", actionExecutionsRoutes(deps));
  api.route("/", terminalRoutes());
  api.route("/", tailscaleRoutes(deps));
  api.route("/", memoryFilesRoutes());
  api.route("/", projectsFilesRoutes(deps));
  api.route("/", syncRoutes(deps));
  api.route("/", shareRoutes(deps));
  const sessionQueries = new SessionQueryService({
    repository: new SessionQueryRepository(deps.db),
    agentLoader: deps.agentLoader,
    appCatalog: deps.appCatalog,
  });
  api.route("/", sessionsRoutes(sessionQueries));

  const { routes: webchatRoutesApp, runtime: webchatRuntime } = createWebchatRuntime(deps);
  api.route("/", webchatRoutesApp);
  // The backend-turn orchestrator is the single holder of the webchat runtime
  // for all backend session tasks (defer + approvals). It's constructed before
  // buildApp runs, so the runtime is bound after the fact, like the rest of the
  // post-setup wiring.
  deps.backendTurnRunner.setWebchatRuntime(webchatRuntime);

  app.route("/api", api);

  // SPA shell. Hono owns it so loopback callers inside the container
  // (`localhost:4141/dashboard`, in-process Chrome CDP, etc.) can reach
  // the dashboard without going through Caddy. External traffic mostly does
  // NOT arrive here: the generated Caddyfile serves the shell + assets
  // straight from disk via `file_server` and proxies only /api, webhooks, app
  // assets, WebSocket upgrades — and the `/apps/*` + `/full/apps/*` document
  // paths, which come here so the social meta can be swapped per app (see
  // lib/caddyfile-generator.ts). Anything else that must reach production
  // browsers has to exist as a file under webRoot (e.g. the boot-written
  // runtime-config.js).
  if (config.webRoot && existsSync(join(config.webRoot, "index.html"))) {
    mountSpa(app, config.webRoot, deps);
  }

  return { app, webchatRuntime };
}

function mountSpa(
  app: Hono,
  webRoot: string,
  deps: Pick<ApiDeps, "appCatalog" | "ogImageStore">,
): void {
  // App document routes get the shell with per-app social meta. Registered
  // before `serveStatic` so the static handler never answers them, and
  // `no-cache` because Caddy set that on the shell before this path existed —
  // a cached shell points at bundle hashes the next image upgrade removes.
  const appDocument = async (c: Context) => {
    const card = await buildAppSocialCard(deps, c.req.raw);
    return c.html(renderSocialMeta(readIndexHtml(webRoot), card), 200, {
      "Cache-Control": "no-cache",
    });
  };
  app.get("/apps/*", appDocument);
  app.get("/full/apps/*", appDocument);

  // Serve hashed assets + public files. `serveStatic` calls next() on
  // miss, so unknown paths fall through to the SPA fallback below.
  app.use(
    "/*",
    serveStatic({
      root: webRoot,
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  );
  // Any non-API, non-static path returns index.html so the SPA router
  // can handle the route (`/dashboard`, `/login`, …).
  app.get("/*", (c) => c.html(readIndexHtml(webRoot)));
}

let cachedIndexHtml: { webRoot: string; html: string } | null = null;
function readIndexHtml(webRoot: string): string {
  if (cachedIndexHtml?.webRoot === webRoot) return cachedIndexHtml.html;
  const html = readFileSync(join(webRoot, "index.html"), "utf-8");
  cachedIndexHtml = { webRoot, html };
  return html;
}

export async function startApi(config: ApiConfig, deps: ApiDeps): Promise<ApiHandle> {
  const { app, webchatRuntime } = buildApp(deps, config);

  return await new Promise<ApiHandle>((resolve, reject) => {
    let server: ServerType;
    try {
      server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
        log.info("api listening", { port: info.port, host: config.host });
        resolve({
          port: info.port,
          close: async () => {
            terminalServer.close();
            desktopProxy.close();
            appWebSocket.close();
            await webchatRuntime.flushAll();
            // Force-close any active HTTP connections so shutdown is not
            // blocked by in-flight requests (e.g. long-lived SSE streams).
            (server as Server).closeAllConnections?.();
            await new Promise<void>((resolveClose, rejectClose) => {
              server.close((err) => (err ? rejectClose(err) : resolveClose()));
            });
          },
        });
      });
      const terminalServer = attachTerminalServer(server as Server, {
        onAuthCommandExit: () => {
          void deps.aiToolState.refresh().catch(() => {});
        },
      });
      const desktopProxy = attachDesktopProxy(server as Server);
      const appWebSocket = attachAppWebSocket(server as Server, deps);
      server.on("error", (err) => {
        log.error("api server error", { error: err.message });
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

export type { ApiConfig, ApiDeps, ApiHandle } from "./deps.js";
