// Rule 10: Rome's read API names the place where speech becomes text before any dictation, and no
// text the guardian reads names the provider; during the script every request that carries
// audio goes to the named place; afterwards the instance holds no audio from voice input.
import { openPage } from "../lib/product.mjs";
import { scriptRuns, setMessages } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";

/**
 * Where Rome names the place: the read API the product builder gave, which answers
 * `{ place: { provider, host } | null }`, and the Settings page, whose path the verifier
 * assumes until the contract states it.
 */
export const PLACE_API = "/api/voice-input";
export const SETTINGS_PATH = "/settings";
const SETTINGS_CHECK = "Settings does not reveal the provider";
/** How long Settings may take to render what it shows after the page loads. */
const SETTINGS_RENDER_MS = 3000;

export default {
  rule: "10",
  title: "Your voice goes only where Rome says, and is not kept",
  phase: 1,
  legA: true,
  /** Rome must name the place before any dictation, so it is read on the fresh instance. */
  async prepare(ctx) {
    ctx.memo.named = await readNamedPlace(ctx, setMessages(ctx.script, "B")[0].path);
  },
  async run(ctx) {
    if (ctx.memo.prepare10)
      throw new Error(`could not read the place: ${ctx.memo.prepare10.error}`);
    await scriptRuns(ctx);
    const named = ctx.memo.named;
    // The iOS app's Settings is the app's to show; leg A reads only what Rome says.
    const settingsCheck =
      ctx.place === "phone"
        ? check(
            SETTINGS_CHECK,
            "not_checked",
            "on iOS the app's Settings is leg B's or C's to check",
          )
        : named.settingsCheck;
    const checks = [named.check, settingsCheck];
    checks.push(trafficCheck(ctx.memo.capture, named.place, named.romeHost));
    checks.push(namedHostUsed(ctx.memo.capture, named.place));
    const scan = await ctx.env.audioScan();
    checks.push(
      required(
        check(
          "no audio kept",
          scan.found.length === 0 ? "pass" : "fail",
          scan.found.length === 0
            ? "the profile folder, database and logs hold no audio"
            : `found ${scan.found.map((f) => `${f.path} (${f.reasons.join(", ")})`).join("; ")}`,
          scan.found.map((f) => f.path),
        ),
      ),
    );
    return ruleResult(checks);
  },
};

async function readNamedPlace(ctx, mic) {
  const opened = await openPage(ctx.env, { mic });
  try {
    const { page } = opened;
    const romeHost = new URL(page.url()).host;
    const response = await page.request.get(new URL(PLACE_API, page.url()).toString());
    const body = response.ok() ? await response.json().catch(() => null) : null;
    const named = body?.place;
    const place =
      named?.provider && named?.host ? { provider: named.provider, host: named.host } : null;
    const apiCheck = required(
      check(
        "read API names the place",
        place ? "pass" : "fail",
        place
          ? `${PLACE_API} names ${place.provider} at ${place.host}`
          : `${PLACE_API} answered ${response.status()} without a provider and host${body?.placeUnknown ? ` (placeUnknown "${body.placeUnknown}")` : ""}`,
      ),
    );
    if (!place)
      return { check: apiCheck, settingsCheck: settingsUnread("no place to look for"), romeHost };
    await page.goto(new URL(SETTINGS_PATH, page.url()).toString());
    // The place sits under Settings → Advanced.
    const name = /^\s*(Advanced|高级)\s*$/;
    const advanced = page
      .getByRole("link", { name })
      .or(page.getByRole("tab", { name }))
      .or(page.getByRole("button", { name }))
      .or(page.getByRole("menuitem", { name }))
      .first();
    // The dashboard renders after load, so wait for the control rather than glance for it.
    if (
      await advanced.waitFor({ state: "visible", timeout: 15000 }).then(
        () => true,
        () => false,
      )
    )
      await advanced.click();
    // Text the guardian reads never names the provider or its host (Ouou, 2026-11-16: show only
    // what the guardian cares about). Settings is where the place was once shown, so it is read.
    await page.waitForTimeout(SETTINGS_RENDER_MS);
    const text = (await page.locator("body").innerText()).toLowerCase();
    const revealed = [place.provider, place.host].filter(
      (p) => p && text.includes(p.toLowerCase()),
    );
    const settingsCheck = required(
      check(
        SETTINGS_CHECK,
        revealed.length === 0 ? "pass" : "fail",
        revealed.length > 0
          ? `Settings → Advanced reveals ${revealed.join(" and ")}`
          : `Settings → Advanced names neither ${place.provider} nor ${place.host}`,
      ),
    );
    return { check: apiCheck, settingsCheck, place, romeHost };
  } finally {
    await opened.close();
  }
}

/**
 * A host without its port or the environment's label, so "transcriber:8790" from Rome and
 * "transcriber (stand-in)" from the capture name the same machine.
 */
function hostname(host) {
  return host.replace(/\s*\(.*\)$/, "").replace(/:\d+$/, "");
}

/** The host Rome names must be the one the audio actually reached, not merely allowed. */
function namedHostUsed(capture, place) {
  const name = "audio reaches the named host";
  if (!capture || !place)
    return required(check(name, "not_checked", "no capture or no named place"));
  // Only the leg from Rome onward can reach the provider; the browser's leg goes to Rome.
  const onward = capture.requests.filter((r) => r.from !== "browser");
  if (onward.length === 0)
    return required(
      check(name, "not_checked", "the capture shows no request carrying audio beyond the browser"),
    );
  const reached = onward.filter((r) => hostname(r.host ?? "") === hostname(place.host));
  return required(
    check(
      name,
      reached.length > 0 ? "pass" : "fail",
      reached.length > 0
        ? `${reached.length} requests carrying audio reached ${place.host}`
        : `no request carrying audio reached ${place.host}; beyond the browser it went to ${[...new Set(onward.map((r) => r.host))].join(", ")}`,
    ),
  );
}

function settingsUnread(reason) {
  return required(check(SETTINGS_CHECK, "not_checked", reason));
}

/**
 * Every captured request that carried audio must go to the named host, or to the guardian's
 * own Rome, through which the rules route speech to the transcriber. Rome Cloud's session
 * request and usage event carry no audio, so they are not in the list; audio sent to Rome
 * Cloud fails like audio sent anywhere else.
 */
function trafficCheck(capture, place, romeHost) {
  const name = "audio goes only to the named place";
  if (!capture) return required(check(name, "not_checked", "no traffic was captured"));
  if (!place) return required(check(name, "not_checked", "Rome names no place to compare with"));
  const audio = capture.requests;
  if (audio.length === 0)
    return required(check(name, "not_checked", "no request carrying audio was captured"));
  const allowed = new Set([hostname(place.host), hostname(romeHost)]);
  const stray = audio.filter((r) => !allowed.has(hostname(r.host ?? "")));
  return required(
    check(
      name,
      stray.length === 0 ? "pass" : "fail",
      stray.length === 0
        ? `${audio.length} requests carried audio, all to ${[...allowed].join(" or ")}`
        : `${stray.length} of ${audio.length} requests carrying audio went elsewhere: ${[...new Set(stray.map((r) => `${r.from} to ${r.host}`))].join(", ")}`,
      stray.map((r) => `${r.from} to ${r.to}: ${r.evidence}`),
    ),
  );
}
