// Client for one Rome instance: its API (the routes the dashboard uses) and
// its stop and start controls. Routes: ../CONTRACT.md#instance.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { follow, forms, json, sleep } from "./http.mjs";

const run = promisify(execFile);

/** Wraps instance `inst` from env.json. */
export function instance(inst, slackOrigin) {
  const api = inst.api.replace(/\/$/, "");
  const origin = new URL(api).origin;
  const call = (path, opts = {}) =>
    json(`${api}${path}`, { ...opts, headers: { ...inst.headers, ...(opts.headers ?? {}) } });

  async function control(what) {
    const target = inst.control[what];
    if (Array.isArray(target)) {
      await run(target[0], target.slice(1), { timeout: 600_000 });
    } else if (/^https?:\/\//.test(target)) {
      const res = await json(target, { method: "POST" });
      if (!res.ok) throw new Error(`${what} ${inst.name}: ${res.status}`);
    } else {
      await run("sh", ["-c", target], { timeout: 600_000 });
    }
  }

  return {
    name: inst.name,
    call,

    /**
     * Walks Connect for the Slack kind the way the dashboard and a browser
     * would, and records every screen it passed. Fills nothing: a setup that
     * asks for a field ends the walk there. Returns the walk with `outcome`
     * "connected", "refused" or "stuck".
     */
    async connect() {
      const walk = { setupFields: [], approveScreens: [], visited: [], agentPicks: 0 };
      const { kind, grant } = inst.connect;
      const started = await call(`/connections/${kind}/grants/${grant}/setup`, {
        method: "POST",
        body: { another: true },
      });
      if (!started.ok) {
        return {
          ...walk,
          outcome: "stuck",
          reason: `start setup: ${started.status} ${JSON.stringify(started.data)}`,
        };
      }
      const cid = started.data.cid;
      let state = started.data.state;
      for (let step = 0; step < 40; step++) {
        if (state.status === "awaiting-input") {
          walk.setupFields.push(...state.form.fields.map((f) => f.label ?? f.name));
          return {
            ...walk,
            outcome: "stuck",
            reason: `setup asked for ${state.form.fields.length} field(s)`,
          };
        }
        if (state.status === "awaiting-redirect") {
          const back = await this.browse(state.url, walk);
          if (back.error) return { ...walk, outcome: "stuck", reason: back.error };
          const ret = await call("/setups/return", { method: "POST", body: back.params });
          state = ret.data?.state ?? { status: "failed", reason: JSON.stringify(ret.data) };
          continue;
        }
        if (state.status === "done") {
          return { ...walk, outcome: "connected", connectionId: state.grant?.connectionId ?? null };
        }
        if (state.status === "failed") {
          return { ...walk, outcome: "refused", reason: state.reason };
        }
        if (state.status === "cancelled") return { ...walk, outcome: "stuck", reason: "cancelled" };
        await sleep(500);
        const polled = await call(`/setups/${cid}`);
        state = polled.data?.state ?? { status: "failed", reason: `poll: ${polled.status}` };
      }
      return { ...walk, outcome: "stuck", reason: "setup did not end in 40 steps" };
    },

    /**
     * Follows a sign-in from `url` until the browser comes back to this
     * instance with the return parameters, pressing Allow (or the first
     * button) on each screen with a form and keeping every preselected
     * choice. Returns those parameters.
     */
    async browse(url, walk) {
      let leg = await follow(url, {
        stopAt: (u) => u.origin === origin && u.searchParams.has("state"),
      });
      for (let screens = 0; screens < 5; screens++) {
        walk.visited.push(...leg.visited.map((v) => new URL(v).origin + new URL(v).pathname));
        if (leg.stoppedAt) {
          const params = Object.fromEntries(leg.stoppedAt.searchParams);
          return { params };
        }
        const found = forms(leg.html, leg.url);
        if (leg.status !== 200 || found.length === 0) {
          return { error: `sign-in stopped at ${leg.url.pathname} (${leg.status}) with no form` };
        }
        const form = found[0];
        walk.approveScreens.push({
          at: leg.url.origin + leg.url.pathname,
          bySlack: leg.url.origin === slackOrigin,
          fields: form.fields.map((f) => f.name),
        });
        const press =
          form.buttons.find((b) => b.value === "allow") ?? form.buttons.find((b) => b.name) ?? {};
        const body = {
          ...form.hidden,
          ...form.defaults,
          ...(press.name ? { [press.name]: press.value } : {}),
        };
        leg = await follow(form.action, {
          method: form.method,
          form: body,
          stopAt: (u) => u.origin === origin && u.searchParams.has("state"),
        });
      }
      return { error: "more than 5 screens in the sign-in" };
    },

    /** Every connected account with its agent and connection. */
    async accounts() {
      const res = await call("/connected-accounts");
      if (!res.ok) throw new Error(`connected-accounts on ${inst.name}: ${res.status}`);
      return res.data.accounts;
    },

    /**
     * Messages Rome recorded from Slack, or null when the instance offers no
     * route to read them (`messagesPath` unset in env.json).
     */
    async recordedMessages() {
      if (!inst.messagesPath) return null;
      const res = await call(inst.messagesPath);
      if (!res.ok) throw new Error(`messages on ${inst.name}: ${res.status}`);
      return res.data.messages;
    },

    stop: () => control("stop"),
    start: () => control("start"),

    /** True once the instance's API answers. */
    async up() {
      try {
        return (await call("/connected-accounts")).ok;
      } catch {
        return false;
      }
    },
  };
}
