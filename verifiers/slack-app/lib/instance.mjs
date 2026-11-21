// Client for one Rome instance: its API (the routes the dashboard uses) and
// its stop and start controls. Routes: ../CONTRACT.md#instance.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { follow, forms, json, sleep } from "./http.mjs";

const run = promisify(execFile);

/** The kind of connection, and the channel Rome records its accounts under. */
const SLACK_KIND = "slack_app";

/** Wraps instance `inst` from env.json. */
export function instance(inst, slackOrigin, { restartSeconds = 300 } = {}) {
    const api = inst.api.replace(/\/$/, "");
  const origin = new URL(api).origin;
  // Rome refuses a mutation that does not come from its own origin, as the
  // dashboard's requests do, so every call carries it.
  const call = (path, opts = {}) =>
    json(`${api}${path}`, {
      ...opts,
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        ...inst.headers,
        ...(opts.headers ?? {}),
      },
    });

  // Set when the environment's record control fails once; the session route
  // is read from then on.
  let recordFailed = null;

  /**
   * Runs control `target` with `args` and parses the JSON it prints last. A
   * URL is POSTed `{args}`; a 404 there reads as null. A command that exits
   * non-zero with JSON on stdout still answers that JSON.
   */
  async function jsonControl(target, args, { name }) {
    if (typeof target === "string" && /^https?:\/\//.test(target)) {
      const res = await json(target, { method: "POST", body: { args } });
      if (res.status === 404) return null;
      if (!res.ok && !res.data) throw new Error(`${name} ${inst.name}: ${res.status}`);
      return res.data;
    }
    const out = await (
      Array.isArray(target)
        ? run(target[0], [...target.slice(1), ...args], { timeout: 300_000 })
        : run("sh", ["-c", `${target} "$@"`, name, ...args], { timeout: 300_000 })
    ).catch((err) => {
      if (err.stdout?.trim()) return { stdout: err.stdout };
      throw new Error(`${name} on ${inst.name} exited ${err.code}: ${(err.stderr ?? "").slice(-400)}`);
    });
    try {
      return JSON.parse(out.stdout);
    } catch {}
    const last = out.stdout.trim().split("\n").reverse().find((l) => /^[[{]/.test(l.trim()));
    if (!last) throw new Error(`${name} on ${inst.name} printed no JSON: ${out.stdout.slice(-300)}`);
    return JSON.parse(last);
  }

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

  /**
   * The channel connection `connection` backs, from its public view. Rome
   * names a chat on a channel `channel:<that channel>:<address>`.
   */
  async function channelOf(connection) {
    if (typeof connection !== "string")
      throw new Error(
        `the setup on ${inst.name} named no connection id, so the chat Rome recorded cannot be found`,
      );
    const path = `/connections/${encodeURIComponent(connection)}`;
    const res = await call(path);
    if (!res.ok)
      throw new Error(`GET ${path} on ${inst.name}: ${res.status} ${JSON.stringify(res.data)}`);
    const channel = res.data?.connection?.channel;
    if (!channel)
      throw new Error(
        `GET ${path} on ${inst.name} names no channel, so the chat Rome recorded cannot be found`,
      );
    return channel;
  }

  return {
    name: inst.name,
    call,
    /** The dashboard's origin and the guardian's headers, for a browser. */
    origin,
    headers: inst.headers,

    /** The connection's public view, or null when Rome no longer knows it. */
    async connection(id) {
      const res = await call(`/connections/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET /connections/${id} on ${inst.name}: ${res.status}`);
      return res.data.connection;
    },

    /** Disconnects in Rome, as the dashboard's Disconnect does. */
    async disconnect(id) {
      const res = await call(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok)
        throw new Error(
          `DELETE /connections/${id} on ${inst.name}: ${res.status} ${JSON.stringify(res.data)}`,
        );
      return res.data;
    },

    /**
     * Runs the environment's seed of the older slack_bot and slack
     * connections an upgrade leaves (R10), and returns what it printed last:
     * per kind its connection_id, account_id and app_id, plus `checks`.
     * Throws with the output when it exits non-zero. Null without a seed.
     */
    async seedOldConnections() {
      const target = inst.control.oldConnections;
      if (!target) return null;
      if (typeof target === "string" && /^https?:\/\//.test(target)) {
        const res = await json(target, { method: "POST" });
        if (!res.ok) throw new Error(`old_connections ${inst.name}: ${res.status} ${JSON.stringify(res.data)}`);
        return res.data;
      }
      const { stdout } = await (
        Array.isArray(target)
          ? run(target[0], target.slice(1), { timeout: 900_000 })
          : run("sh", ["-c", target], { timeout: 900_000 })
      ).catch((err) => {
        throw new Error(`old_connections on ${inst.name} exited ${err.code}: ${(err.stdout ?? "").slice(-800)} ${(err.stderr ?? "").slice(-800)}`);
      });
      const last = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
      return JSON.parse(last);
    },

    /**
     * Which old Slack rows are still stored (R10), read only through the
     * environment's `old-rows` control. Prints per kind {connection_id,
     * stored}. Null without the control; throws when it fails.
     */
    async oldRows() {
      const target = inst.control.oldRows;
      if (!target) return null;
      return jsonControl(target, [], { name: "old-rows" });
    },

    /**
     * The instance's recent log lines, or null when the environment gives no
     * logs command. `since` (an ISO time) is passed on as `--since <time>`
     * to an argv command; a command that ignores it shows its last lines.
     */
    async logs({ since } = {}) {
      const target = inst.control.logs;
      if (!target) return null;
      const extra = since ? ["--since", since] : [];
      const { stdout } = Array.isArray(target)
        ? await run(target[0], [...target.slice(1), ...extra], { timeout: 60_000, maxBuffer: 32 << 20 })
        : await run("sh", ["-c", target], { timeout: 60_000, maxBuffer: 32 << 20 });
      return stdout.split("\n");
    },

    /**
     * Walks Connect for the Slack kind the way the dashboard and a browser
     * would, and records every screen it passed. Fills nothing: a setup that
     * asks for a field ends the walk there. Returns the walk with `outcome`
     * "connected", "refused" or "stuck".
     */
    async connect() {
      const walk = {
        setupFields: [],
        approveScreens: [],
        visited: [],
        agentPicks: 0,
        signIns: 0,
      };
      const { kind, grant } = inst.connect;
      // An instance holds one Slack workspace in phase 1, so Connect takes no
      // `another`. A setup still live from an earlier walk is reattached; this
      // walk starts its own, with `force`.
      const path = `/connections/${kind}/grants/${grant}/setup`;
      let started = await call(path, { method: "POST", body: {} });
      if (started.ok && started.data?.reattached)
        started = await call(path, { method: "POST", body: { force: true } });
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
          walk.signIns++;
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

    /**
     * Every held connection's account, from GET /api/connections (Rome took
     * GET /api/connected-accounts out in #2527): per connection its id, kind,
     * state, account ({platform, id}) and the agent that answers on it, which
     * the kind decides. Placeholders (no id) are left out. Throws, naming the
     * path and status, when the route does not answer a list.
     */
    async accounts() {
      const res = await call("/connections");
      const list = Array.isArray(res.data) ? res.data : res.data?.connections;
      if (!res.ok || !Array.isArray(list))
        throw new Error(
          `GET /api/connections on ${inst.name} answered ${res.status} without a connections list: ${JSON.stringify(res.data).slice(0, 200)}`,
        );
      return list
        .filter((c) => c?.id)
        .map((c) => ({
          connection: c.id,
          kind: c.connectionKind ?? null,
          state: c.state ?? null,
          account: c.account ?? (c.platform ? { platform: c.platform, id: null } : null),
          agent: c.agent ?? null,
          link: c.link ?? null,
        }));
    },

    /**
     * What Rome recorded as coming in through the Slack chat `chat` on
     * `connection`, oldest first: `{text, at, thread}` per inbound message.
     * `chat` is a D... or C... id, or `C...:<thread ts>` for a thread. The
     * environment's `record` control is read when it gives one (`<control>
     * '{"chat": ...}'`, printing `{messages: [{key, text, at, thread?}]}`
     * from Chats' own table); otherwise, or when that control fails, the
     * chat's session (`GET /sessions/channel:<channel>:<chat>/messages`),
     * whose entries carry no thread. A chat Rome never recorded throws
     * unless `noneIfMissing`, where it reads [].
     */
    async recorded(chat, { connection, noneIfMissing = false } = {}) {
      if (inst.control.record && !recordFailed) {
        try {
          const got = await jsonControl(inst.control.record, [JSON.stringify({ chat })], { name: "record" });
          if (got === null && noneIfMissing) return [];
          const list = Array.isArray(got) ? got : (got?.messages ?? []);
          return list.map((m) => ({
            text: typeof m.text === "string" ? m.text : JSON.stringify(m.text ?? m.body ?? ""),
            at: m.at ?? m.createdAt ?? null,
            thread: m.thread ?? m.threadId ?? m.thread_ts ?? null,
          }));
        } catch (err) {
          recordFailed = err.message;
        }
      }
      const session = encodeURIComponent(`channel:${await channelOf(connection)}:${chat}`);
      const res = await call(`/sessions/${session}/messages`);
      if (res.status === 404 && noneIfMissing) return [];
      if (!res.ok)
        throw new Error(
          `GET /sessions/${session}/messages on ${inst.name}: ${res.status} ${JSON.stringify(res.data)}`,
        );
      const list = Array.isArray(res.data) ? res.data : (res.data?.messages ?? []);
      return (
        list
          // Rome records an inbound message as "notification", and as "user"
          // once it starts a turn.
          .filter((m) => m.role === "notification" || m.role === "user")
          .map((m) => ({
            text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            at: m.createdAt ?? null,
            thread: undefined,
          }))
      );
    },

    /** Why the record control was given up for the session route, or null. */
    recordFailed: () => recordFailed,

    /** The text of each message {@link recorded} finds. */
    async recordedIn(chat, opts) {
      return (await this.recorded(chat, opts)).map((m) => m.text);
    },

    /** Whether the environment gives a port control (R9, R14). */
    hasPort: Boolean(inst.control.port),

    /**
     * Tries the port control once, with a method it must refuse, and drops
     * it when it prints no JSON (an environment without `ctl.sh port`).
     * Returns why it was dropped, or null.
     */
    async checkPort() {
      if (!this.hasPort) return "the environment names no port control";
      try {
        await jsonControl(inst.control.port, ["call", JSON.stringify({ method: "api.test", args: {} })], { name: "port" });
        return null;
      } catch (err) {
        this.hasPort = false;
        return err.message;
      }
    },

    /**
     * One operation on the connection's own port, through the environment's
     * `port` control (`<control> <op> '<json>'`, JSON out): send {chat, text,
     * thread?}, read {chat}, thread {chat, ts}, groups {}, call {method,
     * args}. A refusal answers {refused: why}. Null when the environment gives
     * no port.
     */
    async port(op, args = {}) {
      if (!inst.control.port) return null;
      return jsonControl(inst.control.port, [op, JSON.stringify(args)], { name: "port" });
    },

    /**
     * The `channelUserId` of every Slack account this instance has observed.
     * Reads the whole directory, since it files an account under its platform
     * and the channel filter matches that name exactly.
     */
    async slackAccounts() {
      const ids = [];
      let cursor = "";
      for (let page = 0; page < 200; page++) {
        const q = new URLSearchParams();
        if (cursor) q.set("cursor", cursor);
        const res = await call(`/accounts?${q}`);
        if (!res.ok) throw new Error(`accounts on ${inst.name}: ${res.status}`);
        ids.push(
          ...res.data.accounts
            .filter((a) => a.channel === "slack" || a.channel === SLACK_KIND)
            .map((a) => a.channelUserId),
        );
        cursor = res.data.nextCursor;
        if (!cursor) break;
      }
      return ids;
    },

    stop: () => control("stop"),
    start: () => control("start"),

    /** True once the instance's API answers. */
    async up() {
      try {
        return (await call("/connections", { retry: false })).ok;
      } catch {
        return false;
      }
    },
  };
}
