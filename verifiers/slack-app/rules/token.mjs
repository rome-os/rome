// R15 (the token stays in Rome Cloud), rule set v5, with Rome as the
// instances. Rule text: rules.md. Checked at the edges: the tokens the fake
// Slack issued, searched for on each instance (the environment's find_secret,
// counts only) and in the Worker's log; and 10 calls in workspace A from the
// instance bound to B, through the verifier's agent run as that instance,
// counted at the fake.

import { code } from "../lib/codes.mjs";
import { secretTotal } from "../lib/gateway.mjs";
import { issuedTokens, logLines } from "./worker.mjs";

export async function r15(ctx) {
  if (!ctx.env.gateway) return { result: "not checked", reason: "rule set v5 only: the environment runs no slack-gateway Worker" };
  if (!ctx.bound.a || !ctx.bound.b) return { result: "not checked", reason: "R1 or the second binding made no connection to build on." };
  const evidence = {};
  const problems = [];
  const unchecked = [];
  const tokens = await issuedTokens(ctx);
  if (!tokens?.length) return { result: "not checked", reason: "the fake Slack lists no tokens it issued (GET /_control/tokens)" };
  // Rome's app's tokens only: the older apps R10 seeds hold their own, which
  // an upgraded instance keeps in its stored rows by design.
  const romeApp = (await ctx.slack.state()).app?.app_id;
  const ours = tokens.filter((t) => !t.app || !romeApp || t.app === romeApp);
  const values = ours.map((t) => t.value);
  evidence.tokens = { issued: tokens.length, ofRomesApp: values.length, kinds: [...new Set(ours.map((t) => t.kind ?? "?"))] };

  // Not stored or logged on either instance.
  for (const agent of [ctx.agentA, ctx.agentB]) {
    if (!agent?.findSecret) {
      unchecked.push(`${agent?.name ?? "an instance"}: no find_secret control`);
      continue;
    }
    try {
      const found = await agent.findSecretCounts(values);
      evidence[`onInstance_${agent.name}`] = found;
      const read = secretTotal(found);
      if (!read) unchecked.push(`${agent.name}: find_secret answered no count`);
      else if (read.total) problems.push(`a Slack token is on ${agent.name} ${read.total} time(s), in ${read.places.join(", ") || "places it does not name"}`);
    } catch (err) {
      unchecked.push(`${agent.name}: find_secret failed (${err.message.slice(0, 200)})`);
    }
  }
  // Not logged by the Worker.
  const workerLog = await logLines(ctx.env.gateway.logs);
  if (!workerLog) unchecked.push("the Worker's log: no logs control");
  else {
    const hits = workerLog.filter((l) => values.some((v) => l.includes(v))).length;
    evidence.workerLog = { lines: workerLog.length, holdingAToken: hits };
    if (hits) problems.push(`the Worker's log holds a Slack token on ${hits} line(s)`);
  }
  // 10 calls in workspace A from the instance bound to B: none reaches Slack.
  if (!ctx.agentB) unchecked.push("calls from another instance: no as_instance control");
  else {
    const dmA = (await ctx.slack.state()).workspaces.find((w) => w.id === ctx.wsA.id)?.members?.find((m) => m.id === ctx.wsA.guardian)?.im_channel;
    const since = await ctx.slack.seq();
    const answers = [];
    for (let i = 1; i <= 10; i++) {
      const method = i % 2 ? "chat.postMessage" : "conversations.history";
      const args = i % 2 ? { channel: dmA, text: `From the wrong instance (${code("R15", i)})` } : { channel: dmA };
      const r = await ctx.agentB.op("call", { team: ctx.wsA.id, method, args });
      answers.push({ method, status: r.status, error: r.body?.error ?? null });
    }
    const atSlack = (await ctx.slack.calls({ team: ctx.wsA.id, since })).length;
    evidence.crossInstance = { from: ctx.agentB.name, answers, callsAtSlack: atSlack };
    if (atSlack) problems.push(`${atSlack} of 10 calls from the instance bound to B reached Slack in workspace A`);
  }
  const said = `${values.length} issued tokens searched on both instances and in the Worker's log; ${evidence.crossInstance?.callsAtSlack ?? "?"} of 10 calls from the other instance reached Slack`;
  if (problems.length) return { result: "fail", reason: `${said}. ${problems.join("; ")}`, evidence };
  if (unchecked.length) return { result: "not checked", reason: `${said}. Not checked: ${unchecked.join("; ")}`, evidence };
  return { result: "pass", reason: `${said}. No token found anywhere.`, evidence };
}
