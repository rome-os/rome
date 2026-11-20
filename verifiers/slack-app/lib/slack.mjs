// Client for the environment's fake Slack control API
// (environments/slack-app/README.md, "Control API").

import { json } from "./http.mjs";

/** Wraps the control API at `base` (ending in /_control). Every call throws on a non-2xx answer. */
export function fakeSlack(base) {
  const call = async (path, opts) => {
    const res = await json(`${base}${path}`, opts);
    if (!res.ok) throw new Error(`fake Slack ${path}: ${res.status} ${JSON.stringify(res.data)}`);
    return res.data;
  };
  const query = (q) =>
    new URLSearchParams(
      Object.entries(q).filter(([, v]) => v !== undefined && v !== null),
    ).toString();
  const seeded = (r) => ({
    eventId: r.event_id,
    channel: r.event?.channel,
    ts: r.event?.ts ?? r.ts,
    delivery: r.delivery,
    eventSent: r.event_sent ?? null,
  });
  return {
    origin: new URL(base).origin,
    /** Workspaces with their members, direct message ids and installs. */
    state: () => call("/state"),
    /** Picks who the approve screen signs in as. */
    signIn: (team, user) => call("/sign-in", { method: "POST", body: { team, user } }),
    /** A member sends the bot a direct message, signed as Slack signs it. */
    dm: async (team, user, text) =>
      seeded(await call("/dm", { method: "POST", body: { team, user, text } })),
    /**
     * A direct message put in Slack's history only, with no event, so Rome
     * never hears it. Answers whether an event went out anyway.
     */
    dmHistoryOnly: async (team, user, text) => {
      const r = await call("/dm", { method: "POST", body: { team, user, text, send_event: false } });
      return { channel: r.event?.channel, eventSent: r.event_sent !== false };
    },
    /** The same direct message, with a signature Slack did not make. */
    forged: async (team, user, text) =>
      seeded(
        await call("/forged", {
          method: "POST",
          body: { team, user, text, mode: "bad_signature" },
        }),
      ),
    /** A member mentions the bot in a group (default `general`), in a thread with `thread_ts`. */
    mention: async (team, user, text, channel, { thread_ts } = {}) =>
      seeded(
        await call("/mention", {
          method: "POST",
          body: { team, user, channel, text, ...(thread_ts ? { thread_ts } : {}) },
        }),
      ),
    /**
     * A member says something in a group without mentioning the bot, in a
     * thread with `thread_ts`; with `send_event` Slack also sends the app the
     * message event, as if it had subscribed to group messages.
     */
    groupMessage: async (team, user, text, channel, { thread_ts, send_event } = {}) => {
      const r = await call("/group-message", {
        method: "POST",
        body: { team, user, channel, text, ...(thread_ts ? { thread_ts } : {}), ...(send_event ? { send_event: true } : {}) },
      });
      return { ...seeded(r), channel: r.event?.channel ?? r.channel, ts: r.event?.ts ?? r.ts };
    },
    /** The only bot scopes a later sign-in from `team` grants; null lifts the limit. */
    grantLimit: (team, scopes) => call("/grant-limit", { method: "POST", body: { team, scopes } }),
    /** Removes the app from a workspace: Slack's two events, then its tokens stop working. */
    uninstall: (team) => call("/uninstall", { method: "POST", body: { team } }),
    /** auth.test with the newest bot token issued in `team`, as Slack answers it. */
    authTest: async (team) => {
      const r = await call("/auth-test", { method: "POST", body: { team } });
      return { ...(r.auth_test ?? r), tokenState: r.token_state ?? null };
    },
    /** Changes the fake's settings (`history_limit`, `distributed`, ...). */
    config: (body) => call("/config", { method: "POST", body }),
    /** Turns the app's public distribution on or off; off, only its home workspace can install it. */
    setDistributed: (on) => call("/config", { method: "POST", body: { distributed: on } }),
    /** Every answer on the approve screen after `since`: teamId, userId, outcome, error. */
    approvals: async (since) => (await call(`/approvals?${query({ since })}`)).approvals,
    /** Pushes `event` to another app's bot over its Socket Mode connection; says whether it was acked. */
    socketEvent: (appId, event) =>
      call("/socket-event", { method: "POST", body: { app_id: appId, event } }),
    /** The current seq, to read only what comes after it. */
    seq: async () => (await call("/posts?since=999999999")).seq,
    /** What the bot posted, oldest first, after `since`. */
    posts: async ({ team, channel, since }) =>
      (await call(`/posts?${query({ team, channel, since })}`)).posts,
    /** Every delivery attempt of one event, with its status. */
    deliveries: async (eventId) =>
      (await call(`/deliveries?${query({ event_id: eventId })}`)).deliveries,
    /** Every Web API call after `since`, oldest first. */
    calls: async ({ team, method, since } = {}) =>
      (await call(`/calls?${query({ team, method, since })}`)).calls,
  };
}
