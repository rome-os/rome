import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function readJsonBody(request: RomeAppApiRequest): unknown {
  if (!request.body || request.body.byteLength === 0) return null;
  const text = new TextDecoder().decode(request.body);
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // signal malformed JSON
  }
}

class TemplateApiHandler implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const route = request.path.join("/");

    // Who is calling? `request.caller` is resolved by the host before this
    // handler runs (guardian | visitor | anonymous) — never derive identity
    // from headers. Owner-only route? `if (request.caller.kind !== "guardian")
    // return json({ error: "forbidden" }, { status: 403 });`
    //
    // Visitor-facing route (public app, Rome Cloud sign-in)? Use the standard
    // gate — it returns the wire-stable 401 the web SDK's <CallerBadge />
    // understands:
    //
    //   import { requireVisitor } from "@rome-os/app-runtime";
    //   const auth = requireVisitor(request);
    //   if (!auth.ok) return auth.response;
    //   // auth.caller is guardian | visitor from here on

    if (request.method === "GET" && route === "status") {
      return json({
        appId: this.ctx.app.id,
        version: this.ctx.app.version,
        status: "ok",
      });
    }

    if (request.method === "POST" && route === "echo") {
      const payload = readJsonBody(request);
      if (payload === undefined) {
        return json({ error: "invalid_json" }, { status: 400 });
      }
      return json({ received: payload }, { status: 200 });
    }

    if (request.method === "POST" && route === "run-hello") {
      const payload = readJsonBody(request);
      if (payload === undefined) {
        return json({ error: "invalid_json" }, { status: 400 });
      }
      const { message } = (payload ?? {}) as { message?: string };
      const result = await this.ctx.runAction("__APP_ID__:hello", { message });
      return json(result);
    }

    // POST /ask — example of running an agent from the API. The API context
    // only exposes runAction (no direct agentRunner), so agent invocation
    // lives inside an action — see src/actions/ask-agent/. Enable that action
    // and the demo agent in app.yaml before calling this route.
    if (request.method === "POST" && route === "ask") {
      const payload = readJsonBody(request);
      if (payload === undefined) {
        return json({ error: "invalid_json" }, { status: 400 });
      }
      const { prompt } = (payload ?? {}) as { prompt?: string };
      if (typeof prompt !== "string" || !prompt.trim()) {
        return json({ error: "prompt_required" }, { status: 400 });
      }
      try {
        const result = await this.ctx.runAction("__APP_ID__:ask_agent", { prompt });
        return json(result);
      } catch (err) {
        return json(
          { error: "action_unavailable", message: (err as Error).message },
          { status: 503 },
        );
      }
    }

    return json(
      {
        error: "not_found",
        appId: this.ctx.app.id,
        message: `Unknown __APP_NAME__ API route: /${route}`,
      },
      { status: 404 },
    );
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new TemplateApiHandler(ctx);
}
