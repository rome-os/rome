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
    ts: r.event?.ts,
    delivery: r.delivery,
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
    /** The same direct message, with a signature Slack did not make. */
    forged: async (team, user, text) =>
      seeded(
        await call("/forged", {
          method: "POST",
          body: { team, user, text, mode: "bad_signature" },
        }),
      ),
    /** A member mentions the bot in a group (default `general`). */
    mention: async (team, user, text, channel) =>
      seeded(await call("/mention", { method: "POST", body: { team, user, channel, text } })),
    /** A member says something in a group without mentioning the bot. */
    groupMessage: async (team, user, text, channel) => {
      const r = await call("/group-message", {
        method: "POST",
        body: { team, user, channel, text },
      });
      return { ...seeded(r), channel: r.event?.channel ?? r.channel, ts: r.event?.ts ?? r.ts };
    },
    /** Removes the app from a workspace: Slack's two events, then its tokens stop working. */
    uninstall: (team) => call("/uninstall", { method: "POST", body: { team } }),
    /** auth.test with the newest bot token issued in `team`, as Slack answers it. */
    authTest: async (team) => {
      const r = await call("/auth-test", { method: "POST", body: { team } });
      return { ...(r.auth_test ?? r), tokenState: r.token_state ?? null };
    },
    /** Turns the app's public distribution on or off; off, only its home workspace can install it. */
    setDistributed: (on) => call("/config", { method: "POST", body: { distributed: on } }),
    /** Every answer on the approve screen after `since`: teamId, userId, outcome, error. */
    approvals: async (since) => (await call(`/approvals?${query({ since })}`)).approvals,
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
