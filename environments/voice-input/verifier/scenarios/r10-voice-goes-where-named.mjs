// Rule 10: Rome names the place where speech becomes text; during the script every request
// that carries audio goes there; afterwards the instance holds no audio from voice input.
import { openPage } from "../lib/product.mjs";
import { scriptRuns } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";

/**
 * Where Rome names the place. The rules name a Settings page and a read API but not their
 * paths, so these are the verifier's working assumption until the contract states them.
 */
export const PLACE_API = "/api/voice/transcription";
export const SETTINGS_PATH = "/settings";

export default {
  rule: "10",
  title: "Your voice goes only where Rome says, and is not kept",
  phase: 1,
  async run(ctx) {
    await scriptRuns(ctx);
    const named = await readNamedPlace(ctx, ctx.script.messages[0].path);
    const checks = [named.check, named.settingsCheck];
    checks.push(trafficCheck(ctx.memo.capture, named.place, named.romeHost));
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
    const place =
      body?.provider && body?.host ? { provider: body.provider, host: body.host } : null;
    const apiCheck = required(
      check(
        "read API names the place",
        place ? "pass" : "fail",
        place
          ? `${PLACE_API} names ${place.provider} at ${place.host}`
          : `${PLACE_API} answered ${response.status()} without a provider and host`,
      ),
    );
    if (!place)
      return { check: apiCheck, settingsCheck: settingsUnread("no place to look for"), romeHost };
    await page.goto(new URL(SETTINGS_PATH, page.url()).toString());
    const text = await page.locator("body").innerText();
    const shown = text.includes(place.provider) && text.includes(place.host);
    const settingsCheck = required(
      check(
        "Settings names the place",
        shown ? "pass" : "fail",
        shown
          ? `the Settings page shows ${place.provider} and ${place.host}`
          : `the Settings page does not show both ${place.provider} and ${place.host}`,
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

function settingsUnread(reason) {
  return required(check("Settings names the place", "not_checked", reason));
}

/**
 * Every captured request that carried audio must go to the named host, or to the guardian's
 * own Rome, through which the rules route speech to the transcriber.
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
