// A Slack Web API client for the tester's user token. Errors name the method
// and Slack's error code only, so no token or message body reaches a report.

export class SlackError extends Error {
  constructor(method, code) {
    super(`${method}: ${code}`);
    this.method = method;
    this.code = code;
  }
}

/**
 * `call(method, args)` posts form-encoded args with the token as a Bearer
 * header and resolves to Slack's answer, or rejects with a SlackError when
 * Slack answers `ok: false` or not 200.
 */
export function slackClient(token, { fetchFn = fetch, origin = "https://slack.com" } = {}) {
  if (!token) throw new Error("no Slack token");
  return {
    async call(method, args = {}) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined) body.set(k, String(v));
      const res = await fetchFn(`${origin}/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (res.status !== 200) throw new SlackError(method, `http_${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new SlackError(method, data.error ?? "not_ok");
      return data;
    },
  };
}

/** Every page of a cursor-paged method, gathering `key` from each. */
export async function allPages(slack, method, args, key) {
  const items = [];
  let cursor;
  do {
    const page = await slack.call(method, { ...args, cursor, limit: 200 });
    items.push(...(page[key] ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return items;
}
