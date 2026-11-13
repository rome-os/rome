import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { createDocumentsRepository, isDocumentName } from "../db/repositories/documents.js";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function readJsonBody(request: RomeAppApiRequest): unknown {
  if (!request.body || request.body.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(request.body));
  } catch {
    return undefined;
  }
}

class ChiefOfStaffApiHandler implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const route = request.path.join("/");
    const method = request.method;
    const repo = createDocumentsRepository(this.ctx.db);

    if (method === "GET" && request.path.length === 0) {
      return json({ appId: this.ctx.app.id, version: this.ctx.app.version, status: "ok" });
    }

    // GET /state — the roster and the goals document, for the editor.
    if (method === "GET" && route === "state") {
      return json({ documents: repo.all() });
    }

    // PUT /documents/:name — replace the roster or the goals document whole.
    if (method === "PUT" && request.path[0] === "documents" && request.path.length === 2) {
      const name = request.path[1];
      if (!isDocumentName(name)) return json({ error: "unknown_document" }, { status: 404 });
      const payload = readJsonBody(request);
      if (payload === undefined) return json({ error: "invalid_json" }, { status: 400 });
      const body = (payload ?? {}) as { body?: unknown };
      if (typeof body.body !== "string") {
        return json({ error: "body_required" }, { status: 400 });
      }
      return json({ document: repo.set(name, body.body) });
    }

    return json(
      { error: "not_found", message: `Unknown Chief Of Staff API route: /${route}` },
      { status: 404 },
    );
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new ChiefOfStaffApiHandler(ctx);
}
