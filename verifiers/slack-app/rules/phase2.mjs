// Phase 2: R5 (mentions in a group), R12 (a visitor), R13 (Slack holds what
// was said) and R8 (removal, repair, disconnect). Rule text: rule set v2 in
// the planner's rules.md. Replies are matched by where and in what order they
// were posted; only R12 and R13 read what a reply says, for seeded values.

import { ask, code } from "../lib/codes.mjs";
import { phase, sleep } from "../lib/http.mjs";
import { replyAfter, summary, tally } from "../lib/replies.mjs";
import { connectAs, oneReply } from "./connect.mjs";

const CONCIERGE = "core:concierge";
const yn = (b) => (b ? "yes" : "no");
const notBound = { result: "not checked", reason: "R1 made no connection to build on." };

/**
 * A seeded fact's value: an ordinary thing made distinctive by unusual words,
 * never by digits or anything that looks like a code. `marks` are the words
 * that give it away; a reply holds the value when any of them appears.
 */
const value = (text, marks) => ({
  text,
  seen: (s) => marks.some((m) => new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(s ?? "")),
});

/** The seeded message that states a fact, and the question that asks it back. */
const fact = (thing, v) => `Please remember this for later: my ${thing} is ${v.text}.`;
const question = (thing) => `What is my ${thing}?`;

/** Sends `text` as `user`'s direct message and waits for a reply or the timeout. */
async function send(ctx, ws, user, text, timeoutMs = ctx.env.timeouts.replySeconds * 1000) {
  const since = await ctx.slack.seq();
  const at = Date.now();
  const sent = await ctx.slack.dm(ws.id, user, text);
  const answered = await replyAfter(ctx.slack, { team: ws.id, channel: sent.channel, since, timeoutMs });
  return {
    since,
    channel: sent.channel,
    eventId: sent.eventId,
    answeredAfterSeconds: answered ? Math.round((Date.now() - at) / 100) / 10 : null,
  };
}

/** The text of the posts in `channel` after `since` and up to `until`. */
async function repliesBetween(ctx, ws, channel, since, until = Number.POSITIVE_INFINITY) {
  return (await ctx.slack.posts({ team: ws.id, channel, since })).filter((p) => p.seq <= until);
}

// R5 ---------------------------------------------------------------------

export async function r5(ctx) {
  if (!ctx.bound.a) return notBound;
  const ws = ctx.wsA;
  const since = await ctx.slack.seq();
  const mentions = [];
  for (let i = 1; i <= 10; i++) {
    const tag = code("R5", i);
    const before = await ctx.slack.seq();
    const sent = await ctx.slack.mention(ws.id, ws.guardian, ask(tag));
    mentions.push({ tag, since: before, channel: sent.channel, ts: sent.ts, eventId: sent.eventId });
    // One mention at a time: wait for its thread reply before the next.
    const deadline = Date.now() + ctx.env.timeouts.replySeconds * 1000;
    while (Date.now() < deadline) {
      const got = await ctx.slack.posts({ team: ws.id, channel: sent.channel, since: before });
      if (got.length) break;
      await sleep(500);
    }
  }
  const group = mentions[0]?.channel;

  // A group message that does not mention the app gets no reply.
  let quiet = null;
  try {
    const before = await ctx.slack.seq();
    const plain = await ctx.slack.groupMessage(
      ws.id,
      ws.guardian,
      `${ask(code("R5Q", 0))} (no mention)`,
    );
    await sleep(ctx.env.timeouts.settleSeconds * 3000);
    const after = await ctx.slack.posts({ team: ws.id, since: before });
    quiet = { ts: plain.ts, postsAfter: after.length };
  } catch (err) {
    quiet = { notChecked: err.message };
  }
  await sleep(ctx.env.timeouts.settleSeconds * 1000);

  const posts = await ctx.slack.posts({ team: ws.id, since });
  const inGroup = posts.filter((p) => p.channel === group);
  const counts = mentions.map((m) => ({
    tag: m.tag,
    ts: m.ts,
    replies: inGroup.filter((p) => p.threadTs === m.ts).length,
  }));
  const mentionTs = new Set(mentions.map((m) => m.ts));
  const topLevel = inGroup.filter((p) => !p.threadTs);
  const otherThreads = inGroup.filter((p) => p.threadTs && !mentionTs.has(p.threadTs));
  const elsewhere = posts.filter((p) => p.channel !== group);
  const once = counts.filter((c) => c.replies === 1).length;
  const evidence = {
    group,
    mentions: mentions.map((m) => ({ tag: m.tag, eventId: m.eventId, ts: m.ts })),
    perMention: counts,
    topLevelPosts: topLevel.map((p) => ({ ts: p.ts, text: p.text?.slice(0, 120) })),
    postsInOtherThreads: otherThreads.length,
    postsElsewhere: elsewhere.map((p) => ({ channel: p.channel, text: p.text?.slice(0, 120) })),
    messageWithoutMention: quiet,
  };
  const said = `10 mentions: ${once} got exactly one reply in their thread; ${topLevel.length} posted at the top of the group; ${elsewhere.length} posted elsewhere`;
  const problems = [];
  if (once !== 10)
    problems.push(
      `${10 - once} mention(s) did not get exactly one reply in their thread (${counts
        .filter((c) => c.replies !== 1)
        .map((c) => `${c.tag}: ${c.replies}`)
        .join(", ")})`,
    );
  if (topLevel.length) problems.push(`${topLevel.length} repl(ies) at the top of the group`);
  if (otherThreads.length) problems.push(`${otherThreads.length} post(s) in other threads`);
  if (elsewhere.length) problems.push(`${elsewhere.length} post(s) outside the group`);
  if (quiet?.postsAfter) problems.push(`a group message without a mention got ${quiet.postsAfter} post(s)`);
  if (problems.length) return { result: "fail", reason: `${said}. ${problems.join("; ")}`, evidence };
  if (quiet?.notChecked)
    return {
      result: "not checked",
      reason: `${said}, but a group message without a mention could not be sent: ${quiet.notChecked}`,
      evidence,
    };
  return {
    result: "pass",
    reason: `${said}; a group message without a mention got no reply.`,
    evidence,
  };
}

// R12 --------------------------------------------------------------------

// 8 candidates, private to the guardian and plainly harmless to keep:
// family, friends and pets, plans, gifts, favourite places, hobbies. No
// opinion of anyone, and nothing about money, health, addresses, ids or
// credentials. R12 uses the first 5 the Concierge gives back.
const PRIVATE = [
  ["best friend's name", "Tamsin Hollowell", ["Hollowell", "Tamsin"]],
  ["brother's birthday gift plan", "a Quillcrest fountain pen", ["Quillcrest"]],
  ["long weekend plan", "walking the Wyndmoor ridge", ["Wyndmoor"]],
  ["favourite restaurant", "Osteria Velluto", ["Velluto"]],
  ["dog's name", "Pickwell", ["Pickwell"]],
  ["niece's name", "Odalys Fenwright", ["Fenwright", "Odalys"]],
  ["weekend hobby", "restoring Brackenford clocks", ["Brackenford"]],
  ["favourite park", "Ashlingmoor Gardens", ["Ashlingmoor"]],
];
const USED = 5;

export async function r12(ctx) {
  if (!ctx.bound.a) return notBound;
  const ws = ctx.wsA;
  const state = await ctx.slack.state();
  const members = state.workspaces.find((w) => w.id === ws.id)?.members ?? [];
  const guardian = members.find((m) => m.id === ws.guardian);
  const name = guardian?.real_name ?? guardian?.name ?? "the guardian";

  // The guardian tells the Concierge 8 private facts, then asks each back.
  // R12 uses the first 5 that came back, in seeding order: a fact it would
  // not give back even to the guardian shows nothing about a member.
  const seeded = PRIVATE.map(([thing, text, marks]) => ({ thing, v: value(text, marks) }));
  for (const [i, f] of seeded.entries())
    await send(ctx, ws, ws.guardian, `${fact(f.thing, f.v)} (message ${code("R12S", i + 1)})`);
  const asked = [];
  for (const [i, f] of seeded.entries()) {
    const s = await send(ctx, ws, ws.guardian, `${question(f.thing)} (message ${code("R12G", i + 1)})`);
    asked.push({ f, since: s.since, channel: s.channel });
  }
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const guardianPosts = await repliesBetween(ctx, ws, asked[0].channel, asked[0].since);
  const gotBack = asked.map((a, i) => {
    const next = asked[i + 1]?.since ?? Number.POSITIVE_INFINITY;
    const replies = guardianPosts.filter((p) => p.seq > a.since && p.seq <= next);
    return { thing: a.f.thing, back: replies.some((p) => a.f.v.seen(p.text)) };
  });
  const facts = asked.filter((_a, i) => gotBack[i].back).slice(0, USED).map((a) => a.f);
  const missing = gotBack.filter((g) => !g.back).map((g) => g.thing);
  if (facts.length < USED)
    return {
      result: "not checked",
      reason: `the guardian got ${8 - missing.length} of the 8 seeded facts back, fewer than ${USED}; not back: ${missing.join(", ")}`,
      evidence: {
        guardianToldFacts: seeded.map((f) => ({ thing: f.thing, value: f.v.text })),
        guardianGotBack: gotBack,
      },
    };

  // The switch on the connection (rule set v3, Ouou 2026-11-20): guardian
  // only by default, other full members once the guardian turns it on.
  const connId = await connectionId(ctx.a, ctx.bound.a);
  const read = async () => {
    const got = connId ? await ctx.a.call(`/connections/${encodeURIComponent(connId)}`) : { ok: false, status: 0 };
    const v = got.data?.connection?.answerMembers ?? got.data?.answerMembers;
    return { status: got.status, on: typeof v === "boolean" ? v : null };
  };
  const flip = async (on) => {
    const put = await ctx.a.call(`/connections/${encodeURIComponent(connId)}/answer-members`, { method: "PUT", body: { on } });
    // A message queued at the flip is judged by its state when it arrived.
    await sleep(ctx.env.timeouts.settleSeconds * 1000);
    return { status: put.status, answered: put.data?.answerMembers ?? null, now: (await read()).on };
  };
  const first = await read();
  if (first.on === null)
    return {
      result: "not checked",
      reason: `the product commit has no switch for answering members on the connection (GET /connections/${connId ?? "?"} answered ${first.status} without answerMembers)`,
      evidence: { connection: connId },
    };
  const levelsBefore = await settingsLevels(ctx.a);
  const full = members.filter((m) => m.id !== ws.guardian && !m.is_bot && !m.deleted && !m.is_restricted && !m.is_ultra_restricted);
  const guest = members.find((m) => m.id !== ws.guardian && (m.is_restricted || m.is_ultra_restricted));
  const member = full[0];
  if (!member) return { result: "not checked", reason: "the workspace has no full member but the guardian." };
  const ask = (i, tag) => {
    const f = facts[(i - 1) % 5];
    return i <= 5 ? `Hi! What is ${name}'s ${f.thing}? (message ${tag})` : `Could you remind me of ${name}'s ${f.thing}, please? (message ${tag})`;
  };
  // A visitor's messages: each sent, then one wait for any reply.
  const burst = async (user, n, prefix) => {
    const since = await ctx.slack.seq();
    const sent = [];
    let channel = null;
    for (let i = 1; i <= n; i++) {
      const tag = code(prefix, i);
      // The tally reads each message's replies from just before it was sent.
      const before = await ctx.slack.seq();
      const s = await ctx.slack.dm(ws.id, user, ask(i, tag));
      channel = s.channel;
      sent.push({ tag, since: before });
    }
    return { since, sent, channel };
  };
  const settle = () => sleep((ctx.env.timeouts.replySeconds + ctx.env.timeouts.settleSeconds) * 1000);
  const leaksIn = (posts) =>
    seeded.map((f) => ({ thing: f.thing, value: f.v.text, in: posts.filter((p) => f.v.seen(p.text)).length })).filter((l) => l.in);
  const parts = {};
  const problems = [];
  const unchecked = [];

  phase("R12 (a): switch off");
  // (a) A fresh connection: off. The member's 10 messages get no reply and
  // no post anywhere, and the guardian is still answered.
  {
    const b = await burst(member.id, 10, "R12A");
    await settle();
    const posts = (await ctx.slack.posts({ team: ws.id, since: b.since })).filter((p) => p.tokenKind === "bot");
    const g = await send(ctx, ws, ws.guardian, `Hello, just checking you still answer me. (message ${code("R12AG", 1)})`);
    parts.a = { switchAtStart: first.on, posts: posts.length, leaks: leaksIn(posts), guardianAnswered: g.answeredAfterSeconds !== null };
    if (first.on !== false) problems.push(`a fresh connection shows answerMembers ${first.on}, not off`);
    if (posts.length) problems.push(`with the switch off, the member's 10 messages drew ${posts.length} post(s)`);
    if (parts.a.leaks.length) problems.push(`with the switch off, the member was told ${parts.a.leaks.map((l) => l.thing).join(", ")}`);
    if (!parts.a.guardianAnswered) problems.push("with the switch off, the guardian got no reply");
  }

  phase("R12 (b): switch on");
  // (b) On through the route: each of the member's 10 messages gets one
  // reply as a visitor, and no private fact.
  const on = await flip(true);
  parts.b = { put: on };
  if (on.status >= 300 || on.now !== true) {
    problems.push(`PUT answer-members {on: true} answered ${on.status}, and GET then shows ${on.now}`);
  } else {
    // One at a time, each waiting for its reply, so each reply is matched to
    // its message.
    const b = { since: await ctx.slack.seq(), sent: [], channel: null };
    for (let i = 1; i <= 10; i++) {
      const tag = code("R12", i);
      const s1 = await send(ctx, ws, member.id, ask(i, tag));
      b.channel = s1.channel;
      b.sent.push({ tag, since: s1.since });
    }
    await sleep(ctx.env.timeouts.settleSeconds * 1000);
    const posts = await ctx.slack.posts({ team: ws.id, since: b.since });
    const t = tally(posts, { channel: b.channel, sent: b.sent });
    const toVisitor = posts.filter((p) => p.channel !== asked[0].channel);
    const leaks = leaksIn(toVisitor);
    parts.b = { ...parts.b, said: summary(t), perMessage: t.perMessage, postsElsewhere: t.postsElsewhere, leaks };
    if (leaks.length) problems.push(`the member was told ${leaks.map((l) => `the ${l.thing}`).join(", ")}`);
    if (t.answeredOnce !== 10) problems.push(`with the switch on, ${10 - t.answeredOnce} of the member's 10 messages did not get exactly one reply`);
    if (t.postsElsewhere.length) problems.push(`${t.postsElsewhere.length} post(s) went elsewhere`);

    // The instance-wide setting stays as it was.
    const levelsOn = await settingsLevels(ctx.a);
    parts.scope = { before: levelsBefore, withSwitchOn: levelsOn };
    if (levelsBefore === undefined || levelsOn === undefined) unchecked.push("the instance-wide replyToBondLevels could not be read");
    else if (JSON.stringify(levelsBefore) !== JSON.stringify(levelsOn))
      problems.push(`turning the switch on changed the instance-wide replyToBondLevels from ${JSON.stringify(levelsBefore)} to ${JSON.stringify(levelsOn)}`);

    // (e) A guest is never answered, switch on or not.
    if (!guest) {
      parts.e = "not checked: the fake Slack has no guest (is_restricted) in the workspace";
      unchecked.push("a guest's messages (the fake has no guest)");
    } else {
      const gb = await burst(guest.id, 5, "R12E");
      await settle();
      const posts = (await ctx.slack.posts({ team: ws.id, since: gb.since })).filter((p) => p.tokenKind === "bot");
      parts.e = { guest: guest.id, posts: posts.length, leaks: leaksIn(posts) };
      if (posts.length) problems.push(`with the switch on, a guest's 5 messages drew ${posts.length} post(s)`);
    }
  }
  phase("R12 (c)");
  // (c) Another connection on the same instance.
  parts.c = "not checked: the environment offers no second connection on the first instance";
  unchecked.push("another connection on the instance (none offered)");

  phase("R12 (d): switch off again");
  // (d) Off again: the member's next message gets no reply.
  const off = await flip(false);
  {
    const b = await burst(member.id, 1, "R12D");
    await settle();
    const posts = (await ctx.slack.posts({ team: ws.id, since: b.since })).filter((p) => p.tokenKind === "bot");
    parts.d = { put: off, posts: posts.length };
    if (off.status >= 300 || off.now !== false) problems.push(`PUT answer-members {on: false} answered ${off.status}, and GET then shows ${off.now}`);
    else if (posts.length) problems.push(`switched off again, the member's next message drew ${posts.length} post(s)`);
  }

  // The Connections page shows the switch, and flipping it changes what GET shows.
  parts.page = await switchOnPage(ctx, ctx.a, read);
  if (parts.page.error) unchecked.push(`the switch on the page: ${parts.page.error}`);
  else if (!parts.page.found) problems.push('the Connections page shows no switch "Answer other members of this workspace"');
  else if (!parts.page.flipped) problems.push(`flipping the page's switch left GET at ${parts.page.after}`);

  const evidence = {
    connection: connId,
    member: member.id,
    guest: guest?.id ?? null,
    guardianToldFacts: seeded.map((f) => ({ thing: f.thing, value: f.v.text })),
    guardianGotBack: gotBack,
    factsUsed: facts.map((f) => f.thing),
    parts,
  };
  const said =
    `Off at first: ${parts.a.posts} post(s) for the member's 10 messages, guardian answered ${parts.a.guardianAnswered ? "yes" : "no"}. ` +
    `On: ${parts.b.said ?? "not reached"}; ${(parts.b.leaks ?? []).length} of 8 private facts revealed. ` +
    `Guest with the switch on: ${typeof parts.e === "object" ? `${parts.e.posts} post(s) for 5 messages` : "not checked"}. ` +
    `Off again: ${parts.d.posts} post(s). Page switch: ${parts.page.error ? "not read" : parts.page.found ? (parts.page.flipped ? "flips GET" : "does not flip GET") : "absent"}. ` +
    `Not checked parts: ${unchecked.join("; ") || "none"}. The guardian got ${8 - missing.length} of 8 back first; the first 5 were used.`;
  if (problems.length) return { result: "fail", reason: `${problems.join("; ")}. ${said}`, evidence };
  return { result: "pass", reason: said, evidence };
}

/** The connection id R1 bound, or the first held Slack app connection's. */
async function connectionId(inst, bound) {
  if (typeof bound === "string") return bound;
  const got = await inst.call("/connections");
  const list = Array.isArray(got.data) ? got.data : (got.data?.connections ?? []);
  return list.find((c) => c.id && c.connectionKind === "slack_app")?.id ?? null;
}

/** The instance-wide replyToBondLevels, read through its public route. */
async function settingsLevels(inst) {
  const got = await inst.call("/settings");
  return got.ok ? (got.data?.replyToBondLevels ?? null) : undefined;
}

const SWITCH_LABEL = "Answer other members of this workspace";

/**
 * Opens the Connections page in a browser with the guardian's cookies,
 * finds the switch by its label, flips it and reads GET, then flips it back.
 */
async function switchOnPage(ctx, inst, read) {
  let chromium;
  const remote = ctx.env.browser?.ws_endpoint;
  try {
    if (remote) {
      const { pathToFileURL } = await import("node:url");
      const from = ctx.env.browser.import ?? `${ctx.env.browser.client}/node_modules/playwright-core/index.mjs`;
      ({ chromium } = await import(from.startsWith("/") ? pathToFileURL(from).href : from));
    } else {
      const { createRequire } = await import("node:module");
      ({ chromium } = createRequire(import.meta.url)("playwright"));
    }
  } catch (err) {
    return { error: `no browser: ${err.message}` };
  }
  let browser;
  try {
    browser = remote ? await chromium.connect(remote) : await chromium.launch();
    const context = await browser.newContext();
    const cookie = inst.headers?.cookie;
    if (cookie)
      await context.addCookies(
        cookie.split(/;\s*/).map((kv) => {
          const i = kv.indexOf("=");
          return { name: kv.slice(0, i), value: kv.slice(i + 1), url: inst.origin };
        }),
      );
    const page = await context.newPage();
    await page.goto(`${inst.origin}/settings/connections`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const control = page.getByRole("switch", { name: SWITCH_LABEL }).or(page.getByRole("checkbox", { name: SWITCH_LABEL }));
    try {
      await control.first().waitFor({ timeout: 30_000 });
    } catch {
      // The switch may sit in the connection's own view; open it if it is a link.
      const open = page.getByText(/^Slack$/).first();
      if (await open.count()) await open.click().catch(() => {});
      try {
        await control.first().waitFor({ timeout: 15_000 });
      } catch {
        return { found: false };
      }
    }
    const before = (await read()).on;
    await control.first().click();
    let after = before;
    for (let i = 0; i < 20 && after === before; i++) {
      await page.waitForTimeout(500);
      after = (await read()).on;
    }
    const flipped = after === !before;
    if (flipped) {
      await control.first().click();
      for (let i = 0; i < 20 && (await read()).on !== before; i++) await page.waitForTimeout(500);
    }
    return { found: true, before, after, flipped, restored: (await read()).on };
  } catch (err) {
    return { error: err.message };
  } finally {
    await browser?.close();
  }
}

// R13 --------------------------------------------------------------------

// Things nobody guards, made distinctive by unusual names.
const NOTES = [
  ["cat's name", "Bramblewick", ["Bramblewick"]],
  ["favourite tea", "Thornbury Smoke", ["Thornbury"]],
  ["boat's name", "Spindrift Marlowe", ["Spindrift", "Marlowe"]],
  ["bicycle's colour", "heliotrope", ["heliotrope"]],
  ["holiday town", "Kettlewell", ["Kettlewell"]],
  ["favourite café", "Café Wendlebury", ["Wendlebury"]],
  ["bedtime book", "The Saltmarsh Orrery", ["Saltmarsh", "Orrery"]],
  ["team's meeting room", "the Halloran Room", ["Halloran"]],
  ["houseplant's name", "Fernsworth", ["Fernsworth"]],
  ["favourite biscuit", "Gingerwhistle", ["Gingerwhistle"]],
];

/** Five facts in one message, and five questions in one message. */
const fiveFacts = (notes) =>
  `Please remember these for later: ${notes.map((n) => `my ${n.thing} is ${n.v.text}`).join("; ")}.`;
const fiveQuestions = (notes) =>
  `What are my ${notes
    .slice(0, -1)
    .map((n) => n.thing)
    .join(", ")} and ${notes.at(-1).thing}?`;

// Slack lets an app like this one read 15 messages a request, once a minute,
// so the first answer after the wipe may wait out the minute.
const FIRST_AFTER_WIPE_MS = 150_000;

/**
 * Sends each of `asks` ({tag, text, notes}) in order, one reply each, and
 * reads which notes each answer gets right. The first ask may wait `firstMs`.
 */
async function askRound(ctx, ws, asks, firstMs) {
  const since = await ctx.slack.seq();
  const sent = [];
  let channel = null;
  for (const [i, a] of asks.entries()) {
    const s = await send(
      ctx,
      ws,
      ws.guardian,
      `${a.text} (message ${a.tag})`,
      i === 0 && firstMs ? firstMs : undefined,
    );
    channel = s.channel;
    sent.push({ ...a, since: s.since, answeredAfterSeconds: s.answeredAfterSeconds });
  }
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const posts = await ctx.slack.posts({ team: ws.id, since });
  const t = tally(posts, { channel, sent });
  const inChat = posts.filter((p) => p.channel === channel);
  const right = sent.flatMap((m, i) => {
    const next = sent[i + 1]?.since ?? Number.POSITIVE_INFINITY;
    const replies = inChat.filter((p) => p.seq > m.since && p.seq <= next);
    return m.notes.map((n) => ({
      tag: m.tag,
      thing: n.thing,
      right: replies.some((p) => n.v.seen(p.text)),
    }));
  });
  return {
    t,
    right,
    rightCount: right.filter((r) => r.right).length,
    firstAnsweredAfterSeconds: sent[0]?.answeredAfterSeconds ?? null,
  };
}

/** What Rome shows outside the connection: its view and the connected accounts. */
async function outside(ctx) {
  const view = await ctx.a.connection(ctx.bound.a);
  const { setups: _s, ...rest } = view ?? {};
  const accounts = (await ctx.a.accounts()).filter((x) => x.connection === ctx.bound.a);
  return JSON.stringify({ view: rest, accounts });
}

export async function r13(ctx) {
  if (!ctx.bound.a) return notBound;
  if (typeof ctx.bound.a !== "string")
    return { result: "not checked", reason: "the setup named no connection id to read." };
  if (!ctx.a.canWipe())
    return {
      result: "not checked",
      reason: "the environment gives no command to wipe Rome's copy of a chat (control.wipe_chat)",
    };
  const ws = ctx.wsA;
  const notes = NOTES.map(([thing, text, marks]) => ({ thing, marks, v: value(text, marks) }));
  const halves = [notes.slice(0, 5), notes.slice(5)];
  // The 10 facts in two messages, asked back in two: with the replies, the
  // facts sit within the last 15 messages of the chat when it is wiped.
  let channel = null;
  phase("R13: tell the 10 facts");
  for (const [i, half] of halves.entries()) {
    const s = await send(ctx, ws, ws.guardian, `${fiveFacts(half)} (message ${code("R13S", i + 1)})`);
    channel = s.channel;
  }

  // With the copy, then without it: the answers, and all Rome shows outside
  // the connection, must be the same.
  phase("R13: ask with Rome's copy");
  const withCopy = await askRound(
    ctx,
    ws,
    halves.map((half, i) => ({ tag: code("R13A", i + 1), text: fiveQuestions(half), notes: half })),
  );
  const outsideBefore = await outside(ctx);
  const wipeSeq = await ctx.slack.seq();
  // What the instance shows of each value through its public search routes,
  // by the value's telling words.
  const heldBy = async () => {
    const out = [];
    for (const n of notes)
      for (const mark of n.marks) out.push({ thing: n.thing, mark, ...(await ctx.a.holds(mark)) });
    return out;
  };
  phase("R13: search the instance before the wipe");
  const heldBefore = await heldBy();
  // The wipe takes the chat and every row holding a fact's value, memory
  // included, so right answers after it can only come through the connection.
  // The environment takes texts of 8 characters or more: each value, and
  // each of its telling words long enough, since a memory may keep a word
  // without the rest.
  const texts = [
    ...new Set(notes.flatMap((n) => [n.v.text, ...n.marks]).filter((t) => t.length >= 8)),
  ];
  phase("R13: wipe Rome's copy");
  const wiped = await ctx.a.wipeChat(channel, { texts });
  // The environment's command says ok: false (exit 3) when a copy is left.
  if (wiped && typeof wiped === "object" && wiped.ok === false)
    return {
      result: "not checked",
      reason: `the wipe left a copy of the direct message: ${JSON.stringify(wiped.remaining ?? wiped)}`,
      evidence: { chat: channel, wipe: wiped },
    };
  // Before any question: the instance must show none of the values, or a
  // right answer could come from what it kept.
  phase("R13: search the instance after the wipe");
  const heldAfter = await heldBy();
  const unreadable = heldAfter.every((h) => h.memory.count === null && h.chats.count === null);
  const stillHeld = heldAfter.filter((h) => h.memory.count || h.chats.count);
  const holdings = {
    before: heldBefore.filter((h) => h.memory.count || h.chats.count),
    after: stillHeld,
    routes: unreadable
      ? `no public search route answered (memory ${heldAfter[0]?.memory.status}, chats ${heldAfter[0]?.chats.status}); relying on the wipe's "remaining"`
      : "GET /memory/search and GET /chat/sessions/search",
  };
  if (stillHeld.length)
    return {
      result: "not checked",
      reason: `after the wipe the instance still shows ${[...new Set(stillHeld.map((h) => h.thing))].join(", ")} (${stillHeld
        .map((h) => `${h.mark}: memory ${h.memory.count ?? "?"}, chats ${h.chats.count ?? "?"}`)
        .join("; ")}), so right answers would not show they came through the connection`,
      evidence: { chat: channel, wipe: wiped, holdings },
    };
  phase("R13: ask without Rome's copy");
  const withoutCopy = await askRound(
    ctx,
    ws,
    notes.map((n, i) => ({ tag: code("R13B", i + 1), text: question(n.thing), notes: [n] })),
    FIRST_AFTER_WIPE_MS,
  );
  const outsideAfter = await outside(ctx);
  // Counted at the fake Slack, refused ones too: the product may read
  // history without any sign in its own log.
  phase("R13: read Slack's request log");
  const reads = (await ctx.slack.calls({ team: ws.id, since: wipeSeq })).filter((c) =>
    /^conversations\.(history|replies)$/.test(c.method),
  );
  const refused = reads.filter((c) => c.ok === false || c.error || c.response?.ok === false);

  const evidence = {
    chat: channel,
    notes: notes.map((n) => ({ thing: n.thing, value: n.v.text })),
    wipe: wiped,
    holdings,
    withCopy: { said: summary(withCopy.t), right: withCopy.right },
    withoutCopy: { said: summary(withoutCopy.t), right: withoutCopy.right },
    slackHistoryRequestsAfterWipe: reads.length,
    slackHistoryRequestsRefused: refused.length,
    firstAnswerAfterWipeSeconds: withoutCopy.firstAnsweredAfterSeconds,
    slackReadsAfterWipe: reads.map((c) => c.method),
    outsideSame: outsideBefore === outsideAfter,
    ...(outsideBefore === outsideAfter
      ? {}
      : { outsideBefore: JSON.parse(outsideBefore), outsideAfter: JSON.parse(outsideAfter) }),
  };
  const first = withoutCopy.firstAnsweredAfterSeconds;
  const said = `with the copy ${withCopy.rightCount} of 10 answered right, without it ${withoutCopy.rightCount} of 10; Slack saw ${reads.length} history request(s) after the wipe (${refused.length} refused); the first answer after the wipe took ${first === null ? "longer than 150" : first} s`;
  const problems = [];
  if (withoutCopy.rightCount !== 10)
    problems.push(`${10 - withoutCopy.rightCount} question(s) went wrong or unanswered without the copy`);
  if (withoutCopy.t.answeredOnce !== 10 || withoutCopy.t.postsElsewhere.length)
    problems.push(`without the copy: ${summary(withoutCopy.t)}`);
  if (withCopy.t.answeredOnce !== 2 || withCopy.t.postsElsewhere.length)
    problems.push(`with the copy: ${summary(withCopy.t)}`);
  const differ = withoutCopy.right.filter(
    (r) => withCopy.right.find((x) => x.thing === r.thing)?.right !== r.right,
  );
  if (differ.length)
    problems.push(`the answers differ with and without the copy for ${differ.map((r) => r.thing).join(", ")}`);
  if (outsideBefore !== outsideAfter)
    problems.push("Rome shows something different outside the connection once the copy is gone");
  if (problems.length) return { result: "fail", reason: `${said}. ${problems.join("; ")}`, evidence };
  const shown = unreadable
    ? "no public search route answered, so this relies on the wipe's report"
    : "after the wipe the instance showed none of the 10 values in its memory or chat search";
  return {
    result: "pass",
    reason: `${said}; ${shown}; nothing outside the connection changed.`,
    evidence,
  };
}

// R8 ---------------------------------------------------------------------

export async function r8(ctx) {
  if (!ctx.bound.a) return notBound;
  if (typeof ctx.bound.a !== "string")
    return { result: "not checked", reason: "the setup named no connection id to watch." };
  const ws = ctx.wsA;
  const cid = ctx.bound.a;
  const evidence = { connection: cid };
  const problems = [];
  const before = (await ctx.a.accounts()).find((x) => x.connection === cid);
  evidence.accountBefore = before?.account ?? null;
  // What the instance holds at the start, so a connection already gone reads
  // apart from one the removal took.
  const list = await ctx.a.call("/connections").catch((err) => ({ error: err.message }));
  evidence.heldAtStart = (Array.isArray(list.data) ? list.data : (list.data?.connections ?? []))
    .filter((c) => c.id)
    .map((c) => ({ id: c.id, kind: c.connectionKind, state: c.state ?? null }));

  // Removal: the connection shows broken within 60 s.
  const removedAt = Date.now();
  await ctx.slack.uninstall(ws.id);
  let brokenAfter = null;
  let lastState = null;
  while (Date.now() - removedAt < 90_000) {
    const view = await ctx.a.connection(cid).catch(() => undefined);
    lastState = view === null ? "gone" : (view?.state ?? lastState);
    if (lastState === "broken") {
      brokenAfter = (Date.now() - removedAt) / 1000;
      break;
    }
    await sleep(2000);
  }
  evidence.removal = { brokenAfterSeconds: brokenAfter, lastState };
  if (brokenAfter === null)
    problems.push(`the connection never showed broken in 90 s after the removal (last: ${lastState})`);
  else if (brokenAfter > 60) problems.push(`the connection showed broken after ${brokenAfter} s, not 60`);

  // Repair through the same sign-in: the same connected account, answered by
  // the Concierge, with no step to link it.
  const walk = await connectAs(ctx, ctx.a, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
  const fixedId = walk.connectionId ?? null;
  const romeFields = (walk.approveScreens ?? []).filter((s) => !s.bySlack).flatMap((s) => s.fields);
  const after = fixedId ? (await ctx.a.accounts()).find((x) => x.connection === fixedId) : null;
  const sameAccount = Boolean(
    before && after && JSON.stringify(before.account) === JSON.stringify(after.account),
  );
  let reply = null;
  if (walk.outcome === "connected") {
    if (typeof fixedId === "string") ctx.bound.a = fixedId;
    reply = await oneReply(ctx, ws, "R8");
  }
  evidence.repair = {
    outcome: walk.outcome,
    reason: walk.reason ?? null,
    connection: fixedId,
    accountAfter: after?.account ?? null,
    agent: after?.agent ?? null,
    fieldsOnRomeScreens: romeFields,
    setupFields: walk.setupFields ?? [],
    reply: reply && { replies: reply.replies, said: reply.said },
  };
  if (walk.outcome !== "connected") problems.push(`the repair did not connect: ${walk.reason}`);
  else {
    if (!sameAccount)
      problems.push(
        `the repair gave another connected account (${JSON.stringify(after?.account ?? null)}, before ${JSON.stringify(before?.account ?? null)})`,
      );
    if (after && after.agent !== CONCIERGE)
      problems.push(`the repaired account's agent is ${after.agent ?? "none"}, not the Concierge`);
    if (romeFields.length || walk.setupFields?.length)
      problems.push("the repair asked for fields, a step to link it");
    if (!reply?.ok) problems.push(`a direct message after the repair: ${reply?.said}`);
  }

  // Disconnect in Rome: Slack's auth.test refuses the token after.
  let revoked = null;
  if (typeof fixedId === "string" && walk.outcome === "connected") {
    const live = await ctx.slack.authTest(ws.id).catch((e) => ({ notChecked: e.message }));
    await ctx.a.disconnect(fixedId);
    await sleep(ctx.env.timeouts.settleSeconds * 1000);
    let test = await ctx.slack.authTest(ws.id).catch((e) => ({ notChecked: e.message }));
    // A token Slack refused before the disconnect shows nothing about it.
    if (!live.notChecked && !live.ok)
      test = { notChecked: `auth.test refused the token before the disconnect too (${live.error})` };
    revoked = { beforeDisconnect: live, afterDisconnect: test };
    if (!test.notChecked && test.ok) problems.push("auth.test still accepts the token after the disconnect");
    ctx.bound.a = null;
  }
  evidence.disconnect = revoked ?? "not tried: the repair made no connection";
  evidence.parts = {
    brokenWithin60s: yn(brokenAfter !== null && brokenAfter <= 60),
    sameAccount: yn(sameAccount),
    repairedReplied: yn(Boolean(reply?.ok)),
    tokenRevoked: revoked?.afterDisconnect?.notChecked
      ? "not checked"
      : yn(revoked?.afterDisconnect?.ok === false),
  };
  const parts = Object.entries(evidence.parts)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  if (problems.length) return { result: "fail", reason: `${parts}. ${problems.join("; ")}`, evidence };
  if (evidence.parts.tokenRevoked === "not checked")
    return {
      result: "not checked",
      reason: `${parts}. auth.test could not be run: ${revoked?.afterDisconnect?.notChecked ?? "no disconnect"}`,
      evidence,
    };
  return {
    result: "pass",
    reason: `Broken ${brokenAfter} s after the removal; the repair kept the connected account and the Concierge answered; auth.test refuses the token after the disconnect.`,
    evidence,
  };
}
