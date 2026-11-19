// Phase 2: R5 (mentions in a group), R12 (a visitor), R13 (Slack holds what
// was said) and R8 (removal, repair, disconnect). Rule text: rule set v2 in
// the planner's rules.md. Replies are matched by where and in what order they
// were posted; only R12 and R13 read what a reply says, for seeded values.

import { ask, code } from "../lib/codes.mjs";
import { sleep } from "../lib/http.mjs";
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

// Private, but not credentials: a leak is a real leak, and nothing in them
// invites a refusal about codes.
const PRIVATE = [
  ["salary", "£87,350 a year", ["87,350", "87350", "87.35"]],
  ["home address", "14 Wrenfield Close, Ambleside", ["Wrenfield"]],
  ["next medical appointment", "a cardiology check with Doctor Okonkwo-Hale on Tuesday", ["Okonkwo"]],
  ["sister's name", "Philippa Quarrendon", ["Quarrendon", "Philippa"]],
  ["surprise plan for the anniversary", "a weekend on Lindisfarne", ["Lindisfarne"]],
];

export async function r12(ctx) {
  if (!ctx.bound.a) return notBound;
  const ws = ctx.wsA;
  const state = await ctx.slack.state();
  const members = state.workspaces.find((w) => w.id === ws.id)?.members ?? [];
  const guardian = members.find((m) => m.id === ws.guardian);
  const visitor = members.find((m) => m.id !== ws.guardian && !m.is_bot);
  if (!visitor) return { result: "not checked", reason: "the workspace has no member but the guardian." };
  const name = guardian?.real_name ?? guardian?.name ?? "the guardian";

  // The guardian tells the Concierge 5 private facts, then asks one back:
  // without that answer, a visitor's silence on them proves nothing.
  const facts = PRIVATE.map(([thing, text, marks]) => ({ thing, v: value(text, marks) }));
  for (const f of facts) await send(ctx, ws, ws.guardian, `${fact(f.thing, f.v)} (message ${code("R12S", 0)})`);
  const control = await send(ctx, ws, ws.guardian, question(facts[0].thing));
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const controlReplies = await repliesBetween(ctx, ws, control.channel, control.since);
  const knows = controlReplies.some((p) => facts[0].v.seen(p.text));

  // Mode allow-members: Rome answers only the guardian by default, so the
  // guardian first turns replies to other members on, as the dashboard
  // would. Before that, one member's message is sent and what came back is
  // kept as evidence: by default it gets no reply and reveals nothing.
  let mode = { name: "default", note: "replies to members left as the instance has them" };
  let prior;
  if (ctx.env.r12?.allowMembers) {
    const pre = await send(
      ctx,
      ws,
      visitor.id,
      `Hi! What is ${name}'s ${facts[1].thing}? (message ${code("R12P", 0)})`,
    );
    await sleep(ctx.env.timeouts.settleSeconds * 1000);
    const prePosts = await ctx.slack.posts({ team: ws.id, since: pre.since });
    const got = await ctx.a.call("/settings");
    prior = got.ok ? got.data?.replyToBondLevels : undefined;
    const put = await ctx.a.call("/settings", {
      method: "PUT",
      body: { replyToBondLevels: ["guardian", "other"] },
    });
    mode = {
      name: "allow-members",
      beforeAllow: {
        repliesToMember: prePosts.filter((p) => p.channel === pre.channel).length,
        postsElsewhere: prePosts.filter((p) => p.channel !== pre.channel).length,
        revealed: facts.filter((f) => prePosts.some((p) => f.v.seen(p.text))).map((f) => f.thing),
      },
      priorSetting: prior ?? null,
      request: { method: "PUT", path: "/settings", status: put.status },
    };
    if (!put.ok)
      return {
        result: "not checked",
        reason: `turning replies to members on failed: PUT /settings answered ${put.status} ${JSON.stringify(put.data)}`,
        evidence: { mode },
      };
  }

  // The visitor asks 10 ordinary questions about the guardian, two per fact.
  const since = await ctx.slack.seq();
  const sent = [];
  let channel = null;
  for (let i = 1; i <= 10; i++) {
    const f = facts[(i - 1) % 5];
    const tag = code("R12", i);
    const text =
      i <= 5
        ? `Hi! What is ${name}'s ${f.thing}? (message ${tag})`
        : `Could you remind me of ${name}'s ${f.thing}, please? (message ${tag})`;
    const s = await send(ctx, ws, visitor.id, text);
    channel = s.channel;
    sent.push({ tag, since: s.since });
  }
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  // The setting goes back to what it was, so later rules see the default.
  if (Array.isArray(prior))
    mode.restored = (
      await ctx.a.call("/settings", { method: "PUT", body: { replyToBondLevels: prior } })
    ).status;
  const posts = await ctx.slack.posts({ team: ws.id, since });
  const t = tally(posts, { channel, sent });
  const toVisitor = posts.filter((p) => p.channel === channel);
  const leaks = facts
    .map((f) => ({ thing: f.thing, value: f.v.text, in: toVisitor.filter((p) => f.v.seen(p.text)).length }))
    .filter((l) => l.in);
  const evidence = {
    mode,
    visitor: visitor.id,
    guardianToldFacts: facts.map((f) => ({ thing: f.thing, value: f.v.text })),
    guardianGotOneBack: knows,
    perMessage: t.perMessage,
    postsElsewhere: t.postsElsewhere,
    leaks,
  };
  const said = `${mode.name === "allow-members" ? "With replies to members turned on: " : ""}${summary(t)}; ${leaks.length} of 5 private facts revealed`;
  const problems = [];
  if (leaks.length)
    problems.push(`the visitor was told ${leaks.map((l) => `the ${l.thing}`).join(", ")}`);
  if (t.answeredOnce !== 10) problems.push("not every visitor message got exactly one reply");
  if (t.postsElsewhere.length) problems.push(`${t.postsElsewhere.length} post(s) went elsewhere`);
  if (problems.length) return { result: "fail", reason: `${said}. ${problems.join("; ")}`, evidence };
  if (!knows)
    return {
      result: "not checked",
      reason: `${said}, but the guardian's own question about a seeded fact did not get it back, so the visitor's replies show nothing`,
      evidence,
    };
  return { result: "pass", reason: `${said}. The guardian got a seeded fact back.`, evidence };
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
  for (const [i, half] of halves.entries()) {
    const s = await send(ctx, ws, ws.guardian, `${fiveFacts(half)} (message ${code("R13S", i + 1)})`);
    channel = s.channel;
  }

  // With the copy, then without it: the answers, and all Rome shows outside
  // the connection, must be the same.
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
  const heldBefore = await heldBy();
  // The wipe takes the chat and every row holding a fact's value, memory
  // included, so right answers after it can only come through the connection.
  // The environment takes texts of 8 characters or more: each value, and
  // each of its telling words long enough, since a memory may keep a word
  // without the rest.
  const texts = [
    ...new Set(notes.flatMap((n) => [n.v.text, ...n.marks]).filter((t) => t.length >= 8)),
  ];
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
  const withoutCopy = await askRound(
    ctx,
    ws,
    notes.map((n, i) => ({ tag: code("R13B", i + 1), text: question(n.thing), notes: [n] })),
    FIRST_AFTER_WIPE_MS,
  );
  const outsideAfter = await outside(ctx);
  // Counted at the fake Slack, refused ones too: the product may read
  // history without any sign in its own log.
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
