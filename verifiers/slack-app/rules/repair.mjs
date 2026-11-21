// R8 (broken, fixed, disconnected). Rule text: rule set v4 in the planner's
// rules.md.

import { sleep } from "../lib/http.mjs";
import { dmOnRecord } from "../lib/record.mjs";
import { connectAs } from "./connect.mjs";

const yn = (b) => (b ? "yes" : "no");

export async function r8(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
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

  // Removal: the connection shows broken within 1 minute.
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

  // Repair through the same sign-in: the same connected account, with no
  // step to link it, and a direct message on record again.
  const walk = await connectAs(ctx, ctx.a, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
  const fixedId = walk.connectionId ?? null;
  const romeFields = (walk.approveScreens ?? []).filter((s) => !s.bySlack).flatMap((s) => s.fields);
  const after = fixedId ? (await ctx.a.accounts()).find((x) => x.connection === fixedId) : null;
  const sameAccount = Boolean(
    before && after && JSON.stringify(before.account) === JSON.stringify(after.account),
  );
  let heard = null;
  if (walk.outcome === "connected") {
    if (typeof fixedId === "string") ctx.bound.a = fixedId;
    heard = await dmOnRecord(ctx, ctx.a, ws, ctx.bound.a, "R8");
  }
  evidence.repair = {
    outcome: walk.outcome,
    reason: walk.reason ?? null,
    connection: fixedId,
    accountAfter: after?.account ?? null,
    fieldsOnRomeScreens: romeFields,
    setupFields: walk.setupFields ?? [],
    directMessage: heard && { eventId: heard.eventId, tag: heard.tag, onRecord: heard.ok },
  };
  if (walk.outcome !== "connected") problems.push(`the repair did not connect: ${walk.reason}`);
  else {
    if (!sameAccount)
      problems.push(
        `the repair gave another connected account (${JSON.stringify(after?.account ?? null)}, before ${JSON.stringify(before?.account ?? null)})`,
      );
    if (romeFields.length || walk.setupFields?.length)
      problems.push("the repair asked for fields, a step to link it");
    if (!heard?.ok) problems.push("a direct message after the repair was not on record");
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
    repairedHears: yn(Boolean(heard?.ok)),
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
    reason: `Broken ${brokenAfter} s after the removal; the repair kept the connected account and a direct message is on record again; auth.test refuses the token after the disconnect.`,
    evidence,
  };
}
