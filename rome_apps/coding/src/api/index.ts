import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";

// Mocks ship alongside the compiled API module: `dist/api/index.js` and
// `dist/mocks/`. Resolve against import.meta.url so it works wherever the app
// is installed.
const MOCKS_DIR = new URL(/* rspackIgnore: true */ "../mocks/", import.meta.url);

const SLUG = /^[a-z0-9][a-z0-9-]*$/i;

interface MockIndex {
  count: number;
  mocks: Array<Record<string, unknown>>;
}

let indexCache: MockIndex | null = null;

async function loadIndex(): Promise<MockIndex> {
  if (!indexCache) {
    const raw = await readFile(new URL("index.json", MOCKS_DIR), "utf8");
    indexCache = JSON.parse(raw) as MockIndex;
  }
  return indexCache;
}

function notFound(message: string): Response {
  return Response.json({ error: "not_found", message }, { status: 404 });
}

class CodingApiHandler implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    const route = request.path.join("/");

    if (request.path.length === 0) {
      return Response.json({
        appId: this.ctx.app.id,
        version: this.ctx.app.version,
        status: "ok",
      });
    }

    if (route === "status") {
      return Response.json({
        appId: this.ctx.app.id,
        version: this.ctx.app.version,
        status: "ok",
        capabilities: [
          "planning",
          "coding",
          "app_creation",
          "app_verification",
          "frontend-gallery",
        ],
        routeExamples: {
          appHome: `/apps/${this.ctx.app.id}`,
          appApi: `/api/apps/${this.ctx.app.id}/status`,
          gallery: `/api/apps/${this.ctx.app.id}/mocks`,
        },
      });
    }

    // GET mocks — the gallery index consumed by the Frontend section.
    if (route === "mocks") {
      const index = await loadIndex();
      return Response.json(index, {
        headers: { "Cache-Control": "private, max-age=300" },
      });
    }

    // GET mocks/:id — the standalone mock document, rendered in an <iframe>.
    if (request.path[0] === "mocks" && request.path.length === 2) {
      return this.serveFile(request.path[1], "html", "text/html; charset=utf-8");
    }

    // GET prompts/:id — the styling prompt markdown (kept for future use).
    if (request.path[0] === "prompts" && request.path.length === 2) {
      return this.serveFile(`_prompts/${request.path[1]}`, "md", "text/markdown; charset=utf-8");
    }

    return notFound(`Unknown coding API route: /${route}`);
  }

  private async serveFile(id: string, ext: "html" | "md", contentType: string): Promise<Response> {
    const slug = id.startsWith("_prompts/") ? id.slice("_prompts/".length) : id;
    if (!SLUG.test(slug)) {
      return notFound(`Invalid mock id: ${slug}`);
    }
    const fileUrl = new URL(`${id}.${ext}`, MOCKS_DIR);
    try {
      const body = await readFile(fileURLToPath(fileUrl), "utf8");
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch {
      return notFound(`Mock "${slug}" not found`);
    }
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new CodingApiHandler(ctx);
}
