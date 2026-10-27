import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { createProgressRepository } from "../db/repositories/progress.js";
import { welcomeLocaleFromCode, type WelcomeLocale } from "../locale.js";

function requestLocale(request: RomeAppApiRequest): WelcomeLocale | undefined {
  if (!request.body || request.body.byteLength === 0) return undefined;
  try {
    const body = JSON.parse(new TextDecoder().decode(request.body));
    if (!body || typeof body !== "object" || !("locale" in body)) return undefined;
    return welcomeLocaleFromCode((body as { locale?: unknown }).locale);
  } catch {
    return undefined;
  }
}

function requestSessionId(request: RomeAppApiRequest): string | null {
  if (!request.body || request.body.byteLength === 0) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(request.body)) as { sessionId?: unknown };
    const id = body?.sessionId;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * welcome-to-rome app API, called by the landing screen (src/web/App.tsx).
 *
 * - `GET /state` returns the agent name and where the welcome run stands, so
 *   the landing screen can offer to continue a run instead of starting a new
 *   one. The bare app path (`fetchAppApi("")`) is the host's app-management
 *   route, which never reaches this handler, so the landing screen uses this
 *   named route. `GET /` (with a trailing slash) returns the same.
 * - `POST /session` records the chat the landing screen found for a run that
 *   started before the chat was recorded, so later visits skip that search.
 *   It never replaces a recorded chat.
 * - `POST /reset` clears the run before the landing screen opens a new chat.
 *   When supplied, the locale is persisted as the guardian's language before
 *   the chat starts. No memory or transcript is touched.
 */
class WelcomeApiHandler implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const route = request.path.join("/");

    if (request.method === "GET" && (request.path.length === 0 || route === "state")) {
      const { node, aiConnected, completedAt, sessionId } = createProgressRepository(
        this.ctx.db,
      ).get();
      return Response.json({
        appId: this.ctx.app.id,
        version: this.ctx.app.version,
        agentName: await this.getAgentName(),
        progress: { node, aiConnected, completedAt, sessionId },
        status: "ok",
      });
    }

    if (request.method === "POST" && route === "session") {
      const sessionId = requestSessionId(request);
      if (!sessionId) {
        return Response.json({ error: "invalid_session_id" }, { status: 400 });
      }
      const progress = createProgressRepository(this.ctx.db);
      const current = progress.get();
      const saved = current.sessionId === null && current.node !== "greet";
      if (saved) progress.patch({ sessionId });
      return Response.json({ ok: true, saved });
    }

    if (request.method === "POST" && route === "reset") {
      const locale = requestLocale(request);
      if (locale) await this.ctx.repositories.settings.set("guardianLanguage", locale);
      createProgressRepository(this.ctx.db).reset();
      return Response.json({ ok: true });
    }

    return Response.json(
      {
        error: "not_found",
        appId: this.ctx.app.id,
        message: `Unknown welcome-to-rome API route: /${route}`,
      },
      { status: 404 },
    );
  }

  private async getAgentName(): Promise<string> {
    try {
      const value = await this.ctx.repositories.settings.get<string>("agentName");
      return (typeof value === "string" && value.trim()) || "Rome";
    } catch {
      return "Rome";
    }
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new WelcomeApiHandler(ctx);
}
