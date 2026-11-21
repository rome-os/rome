// Sends Rome Cloud the url_verification challenge Slack sends when an app's
// events address is saved, signed with SLACK_APP_SIGNING_SECRET from the
// environment, and checks the answer echoes the challenge as Slack requires.
//
// Usage: node slack-challenge.mjs <events-url> [--host <Host header>]
// Prints {ok, status, url, why?} and exits 0 when Slack would accept the address.

import { createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export function signSlack(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": signature };
}

export async function challenge(url, { secret, host } = {}) {
  const value = randomBytes(16).toString("hex");
  const body = JSON.stringify({ token: "unused", challenge: value, type: "url_verification" });
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const answer = await new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "Slackbot 1.0 (+https://api.slack.com/robots)",
          ...(host ? { host } : {}),
          ...signSlack(secret, body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("timed out after 15 s")));
    req.end(body);
  });
  let echoed = answer.text.trim() === value;
  try {
    echoed ||= JSON.parse(answer.text).challenge === value;
  } catch {}
  const ok = answer.status === 200 && echoed;
  const location = answer.headers.location ?? "";
  const why = ok
    ? undefined
    : /cloudflareaccess\.com|cdn-cgi\/access/.test(location) || answer.status === 403
      ? "Cloudflare Access stopped it: the events path needs a Bypass policy"
      : answer.status === 401
        ? "Rome Cloud refused the signature: SLACK_APP_SIGNING_SECRET differs from Rome Cloud's"
        : answer.status === 200
          ? "the answer did not echo the challenge"
          : `HTTP ${answer.status}`;
  return { ok, status: answer.status, url, ...(why ? { why } : {}) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, ...rest] = process.argv.slice(2);
  const host = rest[0] === "--host" ? rest[1] : undefined;
  const secret = process.env.SLACK_APP_SIGNING_SECRET;
  if (!url || !secret) {
    console.error(
      "usage: SLACK_APP_SIGNING_SECRET=... slack-challenge.mjs <events-url> [--host <name>]",
    );
    process.exit(2);
  }
  const result = await challenge(url, { secret, host }).catch((e) => ({
    ok: false,
    url,
    why: e.message,
  }));
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
