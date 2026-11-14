import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";

// Fake Service signs in through the environment's OAuth test server, at
// onboarding-oauth on the same domain as the Rome. Each request may reach a
// new handler, so the sign-ins in flight and the connected account live in a
// file, which a restart of the Rome's container forgets.
const CLIENT = { id: "rome", secret: "rome" };
const STATE_FILE = join(tmpdir(), "fake-service.json");

interface Saved {
  states: string[];
  account: string | null;
}

function load(): Saved {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Saved;
  } catch {
    return { states: [], account: null };
  }
}

function save(saved: Saved): void {
  writeFileSync(STATE_FILE, JSON.stringify(saved));
}

function issuer(host: string): string {
  const domain = host.split(".").slice(1).join(".");
  return `https://onboarding-oauth.${domain}/fake-service`;
}

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake Service</title><body style="font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">${body}</body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

class FakeServiceApi implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const route = request.path.join("/");
    const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "";

    if (request.method === "POST" && route === "connect-card/connect") {
      // A relative link: core joins it to the address the guardian reached Rome at.
      return Response.json({ open: "/api/apps/fake-service/start" });
    }
    if (request.method === "POST" && route === "connect-card/check") {
      const { account } = load();
      return Response.json(account ? { answer: { service: "Fake Service", status: "connected", account } } : {});
    }
    if (request.method === "POST" && route === "connect-card/dismiss") {
      return Response.json({ answer: { service: "Fake Service", dismissed: true } });
    }
    if (request.method === "GET" && route === "start") {
      const state = crypto.randomUUID();
      const saved = load();
      save({ ...saved, states: [...saved.states.slice(-9), state] });
      const url = new URL(`${issuer(host)}/authorize`);
      url.searchParams.set("client_id", CLIENT.id);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid");
      url.searchParams.set("redirect_uri", `https://${host}/api/apps/fake-service/callback`);
      url.searchParams.set("state", state);
      return Response.redirect(url.href, 302);
    }
    if (request.method === "GET" && route === "callback") {
      const state = request.query.get("state") ?? "";
      const code = request.query.get("code");
      const saved = load();
      if (!saved.states.includes(state) || !code) return html("<h1>Fake Service</h1><p>This sign-in expired. Press Connect on the card again.</p>", 400);
      const token = await fetch(`${issuer(host)}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `https://${host}/api/apps/fake-service/callback`,
          client_id: CLIENT.id,
          client_secret: CLIENT.secret,
        }),
      });
      const tokens = (await token.json().catch(() => null)) as { id_token?: string } | null;
      const claims = tokens?.id_token
        ? (JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()) as { sub?: string })
        : null;
      if (!token.ok || !claims?.sub) {
        this.ctx.log.error("fake service token exchange failed", { status: token.status });
        return html("<h1>Fake Service</h1><p>Signing in failed. Press Connect on the card again.</p>", 502);
      }
      save({ states: saved.states.filter((s) => s !== state), account: claims.sub });
      return html(`<h1>Fake Service is connected</h1><p>Signed in as <b>${claims.sub.replace(/[<>&"]/g, "")}</b>. Go back to the chat and press I've authorized.</p>`);
    }
    return Response.json({ error: `Unknown route: ${request.method} /${route}` }, { status: 404 });
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new FakeServiceApi(ctx);
}
