// R10 (one Slack entry). Rule text: rule set v4 in the planner's rules.md.
// Connect lists only Rome's Slack app; the older Slack bot and the old Slack
// sign-in cannot be started, and a stored connection of either kind is
// ignored at start: not listed, not answering, nothing sent through it.
// Runs last, on the second instance, since seeding the old connections
// writes there.

import { code } from "../lib/codes.mjs";
import { request, sleep, waitFor } from "../lib/http.mjs";
import { refused, why } from "../lib/port.mjs";
import { dmOnRecord } from "../lib/record.mjs";
import { replyAfter } from "../lib/replies.mjs";
import { connectAs } from "./connect.mjs";

const SLACK = /slack/i;

const OLD_KINDS = ["slack_bot", "slack"];

/** An entry's visible name: the API's display name when it gives one, else "Slack". */
function visibleName(c) {
  const named = c?.displayName ?? c?.display_name ?? c?.name ?? c?.title;
  if (typeof named === "string" && named) return named;
  // A label that is the kind itself ("slack_app") is not what the page shows.
  if (typeof c?.label === "string" && c.label && c.label !== c.connectionKind && !/^[a-z0-9]+_[a-z0-9_]+$/.test(c.label)) return c.label;
  return "Slack";
}

/**
 * The Slack entries Connect shows (`GET /connections`), connected or not:
 * `official` counts the official kind's, `oldOffered` the old kinds still
 * offered for a new connection (a placeholder, id null).
 */
async function pickerSlack(inst, officialKind) {
  const res = await inst.call("/connections");
  if (!res.ok) return { error: `GET /connections: ${res.status}` };
  const list = Array.isArray(res.data) ? res.data : (res.data?.connections ?? []);
  const entries = list
    .filter((c) => SLACK.test(c.connectionKind ?? "") || SLACK.test(c.label ?? ""))
    .map((c) => ({ id: c.id ?? null, kind: c.connectionKind, label: c.label }));
  const official = entries.filter((e) => e.kind === officialKind);
  const oldOffered = entries.filter((e) => e.id === null && OLD_KINDS.includes(e.kind));
  return { entries, official: official.length, officialLabel: visibleName(list.find((c) => c.connectionKind === officialKind)), oldOffered: oldOffered.length };
}

/** Starts a new connection of `kind` through its public route; true when refused. */
async function newConnectRefused(inst, kind) {
  if (kind === "slack_bot") {
    const res = await inst.call("/connections/slack_bot/grants/bot/setup", { method: "POST", body: {} });
    const state = res.data?.state;
    const refused = !res.ok || state?.status === "failed";
    return { route: "POST /api/connections/slack_bot/grants/bot/setup", status: res.status, state: state?.status ?? null, refused };
  }
  // The old OAuth kind's start: refused unless it answers 2xx or sends the
  // browser on to a sign-in.
  const res = await request(`${inst.origin}/api/oauth/slack/start`, {
    redirect: "manual",
    headers: { origin: inst.origin, "sec-fetch-site": "same-origin", ...(inst.headers ?? {}) },
  });
  const location = res.headers.get("location");
  const refused = res.status >= 400 || (res.status >= 300 && res.status < 400 && /error|denied|unavailable/i.test(location ?? ""));
  return { route: "GET /api/oauth/slack/start", status: res.status, location, refused };
}

/** The guardian's direct message id in `team`, as the fake names it. */
async function guardianDm(ctx, team, user) {
  const w = (await ctx.slack.state()).workspaces.find((x) => x.id === team);
  return w?.members?.find((m) => m.id === user)?.im_channel ?? null;
}

/** slack_bot sends: the bot hears a direct message over Socket Mode and answers from its own app. */
async function botSends(ctx, ws, bot) {
  const dm = await guardianDm(ctx, ws.id, ws.guardian);
  const tries = [];
  for (let i = 1; i <= 3; i++) {
    const since = await ctx.slack.seq();
    let pushed;
    try {
      pushed = await ctx.slack.socketEvent(bot.app_id, {
        type: "message",
        channel_type: "im",
        channel: dm,
        user: ws.guardian,
        text: `Hello, could you say hello back? (R10 check ${i})`,
        ts: `${Math.floor(Date.now() / 1000)}.${String(i).padStart(6, "0")}`,
      });
    } catch (err) {
      tries.push({ error: err.message });
      continue;
    }
    await replyAfter(ctx.slack, { team: ws.id, channel: dm, since, timeoutMs: ctx.env.timeouts.replySeconds * 1000 });
    const posts = (await ctx.slack.posts({ team: ws.id, channel: dm, since })).filter((p) => p.appId === bot.app_id);
    tries.push({ acked: pushed?.acked ?? null, replies: posts.length });
    if (posts.length) return { ok: true, tries };
  }
  return { ok: false, tries };
}

/**
 * Senders an answer lists to choose from: any list of two or more under a
 * key that names senders, connections or accounts.
 */
function sendersListed(a) {
  if (!a || typeof a !== "object") return null;
  for (const [k, v] of Object.entries(a)) {
    if (Array.isArray(v) && v.length > 1 && /sender|connection|account|choice|option|candidate/i.test(k)) return { key: k, count: v.length };
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = sendersListed(v);
      if (inner) return { ...inner, key: `${k}.${inner.key}` };
    }
  }
  return null;
}

/**
 * A send through the port that names no sender: it must not be refused or
 * answered with senders to choose from, and the fake Slack must show it
 * arrived from Rome's Slack app with its bot token.
 */
async function sendNamingNoSender(ctx, inst, ws, tag) {
  if (!inst.hasPort) return { checked: false, why: "the environment gives no port control" };
  const dm = await guardianDm(ctx, ws.id, ws.guardian);
  const appId = (await ctx.slack.state()).app?.app_id ?? null;
  const since = await ctx.slack.seq();
  let answer;
  try {
    answer = await inst.port("send", { chat: dm, text: `Sent through the port, naming no sender (${tag})` });
  } catch (err) {
    answer = { refused: `the port control failed: ${err.message.slice(0, 300)}` };
  }
  const listed = sendersListed(answer);
  const post = refused(answer) || listed
    ? null
    : await waitFor(async () => (await ctx.slack.posts({ team: ws.id, channel: dm, since })).find((p) => p.text?.includes(tag)), {
        timeoutMs: ctx.env.timeouts.replySeconds * 1000,
      });
  const out = {
    checked: true,
    chat: dm,
    tag,
    answered: answer,
    refused: refused(answer) ? why(answer) : null,
    sendersListed: listed,
    arrived: post ? { appId: post.appId ?? null, tokenKind: post.tokenKind ?? null, romeApp: appId } : null,
  };
  out.problem = out.refused
    ? `the port refused a send naming no sender: ${out.refused}`
    : listed
      ? `the port answered a send naming no sender with ${listed.count} senders to choose from (${listed.key})`
      : !post
        ? "a send through the port naming no sender did not arrive"
        : post.appId !== appId || post.tokenKind !== "bot"
          ? `a send through the port arrived from app ${post.appId} with a ${post.tokenKind} token, not Rome's Slack app (${appId}) with its bot token`
          : null;
  return out;
}

/** Whether each seeded old row is still stored, read through the environment's `old-rows` control. */
async function rowsStored(inst, old) {
  let got;
  try {
    got = await inst.oldRows();
  } catch (err) {
    return { checked: false, why: `the environment's old-rows control failed: ${err.message.slice(0, 300)}` };
  }
  if (got === null || got === undefined) return { checked: false, why: "the environment gives no old-rows control" };
  const list = Array.isArray(got) ? got : (got.rows ?? got.connections ?? null);
  const rows = {};
  for (const kind of OLD_KINDS) {
    const id = old[kind].connection_id;
    const entry = list ? list.find((r) => (r.connection_id ?? r.id) === id) : got[kind];
    rows[kind] = { connection_id: id, stored: Boolean(entry && entry.stored !== false && (entry.connection_id ?? entry.id ?? id) === id) };
  }
  const missing = OLD_KINDS.filter((k) => !rows[k].stored);
  return { checked: true, read: got, rows, problem: missing.length ? `the stored ${missing.join(" and ")} row${missing.length > 1 ? "s are" : " is"} gone` : null };
}

/** One log line read as {level, text, j}: JSON after compose's "service  | " prefix, else plain text. */
function logEntry(line) {
  const body = line.replace(/^[\w.-]+\s+\|\s?/, "");
  const brace = body.indexOf("{");
  if (brace >= 0) {
    try {
      const j = JSON.parse(body.slice(brace));
      const raw = j.level ?? j.severity ?? j.lvl ?? j.levelname;
      const level =
        typeof raw === "number"
          ? raw >= 50 ? "error" : raw >= 40 ? "warn" : "info"
          : /^(error|err|fatal|critical|crit)$/i.test(String(raw)) ? "error" : /^warn(ing)?$/i.test(String(raw)) ? "warn" : String(raw ?? "unknown").toLowerCase();
      return { level, text: body, j };
    } catch {}
  }
  const level = /\b(ERROR|FATAL)\b|^\s*\w*Error:/.test(body) ? "error" : /\bWARN(ING)?\b/.test(body) ? "warn" : "unknown";
  return { level, text: body, j: null };
}

/**
 * The lines in `cur` logged after `prev`: those after the last place prev's
 * last five lines appear in cur. `gap` when they no longer appear, since a
 * logs control may show only its last lines.
 */
function logSince(prev, cur) {
  const tail = prev.filter((l) => l.trim()).slice(-5);
  const lines = cur.filter((l) => l.trim());
  if (!tail.length) return { lines, gap: false };
  for (let i = lines.length - tail.length; i >= 0; i--)
    if (tail.every((t, j) => lines[i + j] === t)) return { lines: lines.slice(i + tail.length), gap: false };
  return { lines, gap: true };
}

const STARTED = /Rome started/;
const component = (e) => e.j?.component ?? e.j?.name ?? e.j?.module ?? null;
const short = (e) => e.text.slice(0, 400);

/** Whether some key naming a kind holds `slack_bot` or `slack`, anywhere in `j`. */
function namesOldKind(j) {
  if (!j || typeof j !== "object") return false;
  return Object.entries(j).some(([k, v]) => (/kind/i.test(k) && OLD_KINDS.includes(v)) || (v && typeof v === "object" && namesOldKind(v)));
}

/**
 * An error-level entry about an old row: it names a seeded row's connection
 * id or account id, names `slack_bot`, holds `slack_bot` or `slack` under a
 * key naming a kind, or comes from the `connections` component. The bare word
 * "slack" is not enough, since Rome's Slack app is live.
 */
function aboutOldRow(e, old) {
  const ids = OLD_KINDS.flatMap((k) => [old[k].connection_id, old[k].account_id]).filter(Boolean);
  const c = String(component(e) ?? "");
  return ids.some((id) => e.text.includes(id)) || /\bslack_bot\b/.test(e.text) || namesOldKind(e.j) || c === "connections" || /^connections[:.]/.test(c);
}

/** Other error-level entries, counted by component and message, so a new one is seen. */
function errorNotes(entries) {
  const counts = {};
  for (const e of entries) {
    const key = `${component(e) ?? "?"}: ${String(e.j?.msg ?? e.j?.message ?? e.text).slice(0, 120)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Rome's log over one start, from the stop to the step's end. The start
 * window, up to "Rome started", holds no error-level entry and one warning
 * for each seeded old row, matched by its connection id, else its account
 * id, else its kind as a quoted value. After it, only an error about an old
 * row fails; any other error is listed as a note. `before` are the lines
 * logged between the last step's end and the stop, judged as running lines.
 */
function judgeLog(lines, old, before = []) {
  const entries = lines.map(logEntry);
  const at = entries.findIndex((e) => STARTED.test(e.text));
  if (at < 0) return { checked: false, why: `no "Rome started" line among the ${lines.length} lines read since the stop` };
  const window = entries.slice(0, at);
  const running = [...before.map(logEntry), ...entries.slice(at + 1)];
  const startErrors = window.filter((e) => e.level === "error");
  const warns = window.filter((e) => e.level === "warn");
  const by = (pick) => Object.fromEntries(OLD_KINDS.map((k) => [k, warns.filter((w) => pick(k) && w.text.includes(pick(k))).map(short)]));
  let matchedBy = "connection id";
  let perRow = by((k) => old[k].connection_id);
  if (OLD_KINDS.every((k) => !perRow[k].length)) {
    matchedBy = "account id";
    perRow = by((k) => old[k].account_id);
  }
  if (OLD_KINDS.every((k) => !perRow[k].length)) {
    matchedBy = "kind";
    perRow = by((k) => `"${k}"`);
  }
  const runningErrors = running.filter((e) => e.level === "error");
  const aboutOld = runningErrors.filter((e) => aboutOldRow(e, old));
  const problems = [];
  if (startErrors.length) problems.push(`${startErrors.length} error-level entr${startErrors.length > 1 ? "ies" : "y"} while starting`);
  for (const k of OLD_KINDS)
    if (perRow[k].length !== 1) problems.push(`${perRow[k].length} warnings for the stored ${k} row while starting, not 1`);
  if (aboutOld.length) problems.push(`${aboutOld.length} error-level entr${aboutOld.length > 1 ? "ies" : "y"} about an old row after "Rome started"`);
  return {
    checked: true,
    startLines: window.length,
    runningLines: running.length,
    unparsed: entries.filter((e) => !e.j).length,
    startErrors: startErrors.map(short),
    warnings: perRow,
    matchedBy,
    errorsAboutOldRows: aboutOld.map(short),
    otherErrors: errorNotes(runningErrors.filter((e) => !aboutOldRow(e, old))),
    problems,
  };
}

export async function r10(ctx) {
  const inst = ctx.b;
  const ws = ctx.wsB;
  const officialKind = ctx.env.instances[1]?.connect?.kind ?? "slack_app";
  const evidence = {};
  const problems = [];
  const unchecked = [];
  const pickerHolds = (p, when) => {
    if (p.error) return unchecked.push(`picker ${when}: ${p.error}`);
    if (p.official !== 1) problems.push(`Connect shows ${p.official} entries of Rome's Slack app ${when}, not 1`);
    if (p.oldOffered) problems.push(`Connect offers ${p.oldOffered} old Slack kind(s) ${when}`);
  };
  pickerHolds((evidence.pickerBefore = await pickerSlack(inst, officialKind)), "before the upgrade");
  for (const kind of ["slack_bot", "slack"]) {
    const r = await newConnectRefused(inst, kind);
    evidence[`newConnect_${kind}`] = r;
    if (!r.refused) problems.push(`a new ${kind} connection could be started (${r.route} answered ${r.status})`);
  }
  // Rome's Slack app on B, which R10 disconnected.
  if (!(await inst.accounts()).some((x) => x.kind === officialKind)) {
    const walk = await connectAs(ctx, inst, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
    evidence.reconnect = { outcome: walk.outcome, reason: walk.reason ?? null };
    if (walk.outcome !== "connected")
      return { result: "not checked", reason: `Rome's Slack app could not be connected to ${ws.id} again: ${walk.reason}`, evidence };
  }
  const officialId = async () => (await inst.accounts()).find((x) => x.kind === officialKind)?.connection;
  const startSeq = await ctx.slack.seq();
  // Rome's log before the seed, so each start's lines can be told apart.
  // From a minute before the seed, where the logs control takes --since.
  const logsFrom = new Date(Date.now() - 60_000).toISOString();
  const readLogs = async () => {
    try {
      return { lines: await inst.logs({ since: logsFrom }) };
    } catch (err) {
      return { error: err.message.slice(0, 300) };
    }
  };
  // The instance stops first, so the lines after this read are its start's.
  await inst.stop();
  let anchor = await readLogs();
  let old;
  try {
    old = await inst.seedOldConnections();
  } catch (err) {
    if (!(await inst.up())) await inst.start().catch(() => {});
    return { result: "not checked", reason: `the environment's seed of the old connections failed: ${err.message.slice(0, 300)}`, evidence };
  }
  if (!old?.slack_bot || !old?.slack) return { result: "not checked", reason: "the seed named no slack_bot or slack connection", evidence: { ...evidence, seed: old ?? null } };
  evidence.seed = old;
  evidence.steps = {};
  for (const when of ["after the upgrade", "after a restart"]) {
    let before = [];
    if (when === "after a restart") {
      const ended = await readLogs();
      await inst.stop();
      const stopped = await readLogs();
      // Lines between the last step's end and the stop: judged as running.
      if (ended.lines && stopped.lines) before = logSince(ended.lines, stopped.lines).lines;
      anchor = stopped;
      await inst.start();
      const up = Date.now() + ctx.env.timeouts.restartSeconds * 1000;
      while (Date.now() < up && !(await inst.up())) await sleep(1000);
      await sleep(ctx.env.timeouts.settleSeconds * 1000);
    }
    const step = {};
    const held = await inst.accounts();
    step.held = held.map((x) => x.kind);
    const oldHeld = held.filter((x) => OLD_KINDS.includes(x.kind));
    if (oldHeld.length) problems.push(`${when}, Rome lists ${oldHeld.map((x) => x.kind).join(", ")}`);
    if (!held.some((x) => x.kind === officialKind)) problems.push(`${when}, Rome does not list Rome's Slack app`);
    step.bot = await botSends(ctx, ws, old.slack_bot);
    if (step.bot.ok) problems.push(`${when}, the older Slack bot still answered`);
    step.dm = await dmOnRecord(ctx, inst, ws, await officialId(), "R10D");
    if (!step.dm.ok) problems.push(`${when}, a direct message to Rome's Slack app was not on record`);
    // A send that names no sender goes out through Rome's Slack app.
    step.send = await sendNamingNoSender(ctx, inst, ws, code("R10S", when === "after a restart" ? 2 : 1));
    if (!step.send.checked) unchecked.push(`${when}, a send naming no sender: ${step.send.why}`);
    else if (step.send.problem) problems.push(`${when}, ${step.send.problem}`);
    // The seeded rows are still stored: no migration deletes them.
    step.rows = await rowsStored(inst, old);
    if (!step.rows.checked) unchecked.push(`${when}, the stored rows: ${step.rows.why}`);
    else if (step.rows.problem) problems.push(`${when}, ${step.rows.problem}`);
    evidence.steps[when] = step;
    if (when === "after a restart") pickerHolds((evidence.pickerFinal = await pickerSlack(inst, officialKind)), "at the end");
    // Rome's log over this start: from the stop to here.
    const logsNow = await readLogs();
    if (anchor.error || logsNow.error || !anchor.lines || !logsNow.lines) {
      step.log = { checked: false, why: anchor.error ?? logsNow.error ?? "the environment gives no logs control" };
    } else {
      const span = logSince(anchor.lines, logsNow.lines);
      step.log = span.gap
        ? { checked: false, why: "more lines were logged than the logs control shows, so the start's own lines cannot be told apart" }
        : judgeLog(span.lines, old, before);
    }
    if (!step.log.checked) unchecked.push(`${when}, Rome's log: ${step.log.why}`);
    else for (const p of step.log.problems) problems.push(`${when}, Rome's log holds ${p}`);
  }
  // Nothing went through the old sign-in or the older bot: no post from
  // either app, no call with the sign-in's user token.
  const posts = await ctx.slack.posts({ team: ws.id, since: startSeq });
  const calls = await ctx.slack.calls({ team: ws.id, since: startSeq });
  const oldApps = new Set([old.slack.app_id, old.slack_bot.app_id].filter(Boolean));
  evidence.throughOld = {
    posts: posts.filter((p) => oldApps.has(p.appId) || p.tokenKind === "user").map((p) => ({ channel: p.channel, appId: p.appId ?? null, tokenKind: p.tokenKind })),
    userTokenCalls: calls.filter((c) => c.tokenKind === "user").map((c) => c.method),
  };
  if (evidence.throughOld.posts.length) problems.push(`${evidence.throughOld.posts.length} post(s) went out through an old Slack connection`);
  if (evidence.throughOld.userTokenCalls.length)
    problems.push(`${evidence.throughOld.userTokenCalls.length} call(s) at Slack used the old sign-in's user token (${[...new Set(evidence.throughOld.userTokenCalls)].join(", ")})`);
  const said = Object.entries(evidence.steps)
    .map(
      ([when, s]) =>
        `${when}: listed ${s.held.join(", ") || "nothing"}; old bot answered ${s.bot.ok ? "yes" : "no"}; DM on record ${s.dm.ok ? "yes" : "no"}; ` +
        `a send naming no sender ${!s.send.checked ? "not checked" : s.send.problem ? "failed" : "arrived from Rome's Slack app"}; ` +
        `old rows ${!s.rows.checked ? "not checked" : s.rows.problem ? "gone" : "still stored"}; ` +
        `log ${!s.log.checked ? "not checked" : `${s.log.startErrors.length} errors while starting, warnings slack_bot ${s.log.warnings.slack_bot.length} and slack ${s.log.warnings.slack.length}, ${s.log.errorsAboutOldRows.length} errors about an old row after, ${Object.values(s.log.otherErrors).reduce((a, b) => a + b, 0)} other errors (notes)`}`,
    )
    .join(". ");
  if (problems.length) return { result: "fail", reason: `${problems.join("; ")}. ${said}`, evidence };
  if (unchecked.length) return { result: "not checked", reason: `not all checked (${unchecked.join("; ")}). ${said}`, evidence };
  return { result: "pass", reason: said, evidence };
}
