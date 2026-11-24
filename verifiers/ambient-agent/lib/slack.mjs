// Client for the environment's fake Slack control API
// (environments/slack-app/README.md, "Control API").

/** Wraps the control API at `base` (ending in /_control). Every call throws on a non-2xx answer. */
export function fakeSlack(base) {
  const call = async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok)
      throw new Error(`fake Slack ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return data;
  };
  const query = (q) =>
    new URLSearchParams(
      Object.entries(q).filter(([, v]) => v !== undefined && v !== null),
    ).toString();
  const said = (r) => ({
    ts: r.event?.ts ?? r.ts,
    channel: r.event?.channel ?? null,
    eventSent: r.event_sent === true,
    status: r.delivery?.status ?? null,
  });
  const thread = (threadTs) => (threadTs ? { thread_ts: threadTs } : {});
  return {
    /** Workspaces with their members, groups and installs. */
    state: () => call("/state"),
    /** The current seq: records after it are what comes next. */
    seq: async () => (await call("/posts?since=999999999")).seq,
    /** A member writes in a group without mentioning the bot; it enters the history only. */
    groupMessage: async (team, user, channel, text, threadTs) =>
      said(
        await call("/group-message", {
          method: "POST",
          body: { team, user, channel, text, ...thread(threadTs) },
        }),
      ),
    /** A member mentions the bot in a group; Slack sends app_mention. Resolves once the first delivery answered. */
    mention: async (team, user, channel, text, threadTs) =>
      said(
        await call("/mention", {
          method: "POST",
          body: { team, user, channel, text, ...thread(threadTs) },
        }),
      ),
    /** A member writes the bot a direct message; Slack sends message.im. */
    dm: async (team, user, text, threadTs) =>
      said(await call("/dm", { method: "POST", body: { team, user, text, ...thread(threadTs) } })),
    /**
     * Several members write at the same moment: each item is
     * {kind: "mention"|"dm"|"group-message", user, channel?, text, threadTs?}.
     * Every message takes its ts first and every event goes out at once.
     * Resolves to one result per item, in order.
     */
    batch: async (team, items) => {
      const body = {
        items: items.map((i) => ({
          kind: i.kind,
          team,
          user: i.user,
          channel: i.channel,
          text: i.text,
          ...thread(i.threadTs),
        })),
      };
      return (await call("/batch", { method: "POST", body })).results.map(said);
    },
    /** What the app posted after `since`, oldest first: {seq, channel, ts, threadTs, text}. */
    posts: async ({ team, channel, since }) =>
      (await call(`/posts?${query({ team, channel, since })}`)).posts,
    /** Every Web API call after `since`, oldest first. */
    calls: async ({ team, method, since }) =>
      (await call(`/calls?${query({ team, method, since })}`)).calls,
  };
}
