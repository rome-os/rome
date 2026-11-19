// Stand-in for Rome Cloud and the webhook relay, in one server. It plays the
// shape the briefs give the real ones: Rome Cloud brokers the sign-in, holds
// the app's secrets, checks Slack's signature and binds one workspace to one
// instance; the relay keeps a mailbox per instance and knows nothing of Slack.
// `breaks` switches one rule off at a time (README.md, "Stand-in").

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readBody, send, serve } from "./serve.mjs";

const rand = () => randomBytes(8).toString("hex");

/** HMAC SHA256 of `body` with `secret`, hex. Rome Cloud signs relay frames with it. */
export const frameSignature = (secret, body) =>
  createHmac("sha256", secret).update(body).digest("hex");

const sameHex = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startCloud({
  slackUrl,
  clientId,
  clientSecret,
  signingSecret,
  instanceSecrets,
  breaks,
}) {
  const pending = new Map();
  const handoffs = new Map();
  const bindings = new Map();
  const mailboxes = new Map(Object.keys(instanceSecrets).map((n) => [n, []]));
  let self;

  const authorized = (req, name) => req.headers.authorization === `Bearer ${instanceSecrets[name]}`;

  function slackSigned(req, body) {
    const ts = req.headers["x-slack-request-timestamp"];
    const sig = req.headers["x-slack-signature"] ?? "";
    if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const want = `v0=${createHmac("sha256", signingSecret).update(`v0:${ts}:${body}`).digest("hex")}`;
    return sameHex(sig, want);
  }

  function deposit(name, body) {
    const frame = { id: rand(), body, sig: frameSignature(instanceSecrets[name], body) };
    mailboxes.get(name).push(frame);
  }

  self = await serve(async (req, res, url) => {
    const p = url.pathname;

    // Sign-in: the instance sends the browser here; Rome Cloud sends it on to Slack.
    if (p === "/slack/connect") {
      const cloudState = rand();
      pending.set(cloudState, {
        instance: url.searchParams.get("instance"),
        state: url.searchParams.get("state"),
        back: url.searchParams.get("return"),
      });
      const to = new URL("/oauth/v2/authorize", slackUrl);
      to.searchParams.set("client_id", clientId);
      to.searchParams.set("scope", "im:history,chat:write,app_mentions:read");
      to.searchParams.set("redirect_uri", `${self.url}/slack/callback`);
      to.searchParams.set("state", cloudState);
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }

    if (p === "/slack/callback") {
      const from = pending.get(url.searchParams.get("state"));
      pending.delete(url.searchParams.get("state"));
      if (!from) return send(res, 400, { error: "unknown sign-in" });
      const back = new URL(from.back);
      back.searchParams.set("state", from.state);
      const exchange = await fetch(`${slackUrl}/api/oauth.v2.access`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: url.searchParams.get("code") ?? "",
          redirect_uri: `${self.url}/slack/callback`,
        }),
      }).then((r) => r.json());
      if (!exchange.ok) {
        back.searchParams.set("error", "slack_refused");
        back.searchParams.set("message", `Slack refused the sign-in: ${exchange.error}`);
      } else {
        const team = exchange.team.id;
        const bound = bindings.get(team);
        // Like the product, a bound workspace still returns a handoff, and
        // the redeem refuses it.
        const refused = Boolean(bound && bound !== from.instance && !breaks.has("R3"));
        if (!refused) bindings.set(team, from.instance);
        const handoff = rand();
        handoffs.set(handoff, {
          instance: from.instance,
          team,
          botToken: exchange.access_token,
          botUserId: exchange.bot_user_id,
          refused,
        });
        back.searchParams.set("handoff", handoff);
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (p === "/slack/redeem" && req.method === "POST") {
      const { instance, handoff } = JSON.parse(await readBody(req));
      const h = handoffs.get(handoff);
      handoffs.delete(handoff);
      if (!h || h.instance !== instance || !authorized(req, instance))
        return send(res, 403, { error: "bad handoff" });
      if (h.refused)
        return send(res, 409, {
          error: "workspace_bound",
          message:
            "This Slack workspace is already connected to another Rome. Disconnect Slack in the other Rome first, then connect it here.",
        });
      return send(res, 200, { team: h.team, botToken: h.botToken, botUserId: h.botUserId });
    }

    // Slack's events address for the one app.
    if (p === "/slack/events" && req.method === "POST") {
      const body = await readBody(req);
      // Broken R7-transport: an event with a bad signature never gets an
      // answer, as if the network dropped it.
      if (breaks.has("R7-transport") && !slackSigned(req, body)) return req.socket.destroy();
      if (!breaks.has("R7-signature") && !slackSigned(req, body))
        return send(res, 401, { error: "bad signature" });
      const payload = JSON.parse(body);
      if (payload.type === "url_verification")
        return send(res, 200, { challenge: payload.challenge });
      const targets = breaks.has("R7-route")
        ? [...new Set(bindings.values())]
        : [bindings.get(payload.team_id)];
      for (const t of targets.filter(Boolean)) deposit(t, body);
      return send(res, 200, { ok: true });
    }

    // The relay: each instance drains its own mailbox and acks what it took.
    const box = p.match(/^\/relay\/([\w-]+)\/(drain|ack)$/);
    if (box) {
      const [, name, op] = box;
      if (!authorized(req, name)) return send(res, 403, { error: "not this instance" });
      if (op === "drain") return send(res, 200, { frames: mailboxes.get(name) });
      const { ids } = JSON.parse(await readBody(req));
      mailboxes.set(
        name,
        mailboxes.get(name).filter((f) => !ids.includes(f.id)),
      );
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  });
  return self;
}
