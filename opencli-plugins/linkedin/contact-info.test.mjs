import assert from "node:assert/strict";
import test from "node:test";
import { BrowserConnectError, CommandExecutionError } from "@jackwener/opencli/errors";
import { getRegistry } from "@jackwener/opencli/registry";
import { openLinkedInContactSection } from "./linkedin-browser.mjs";
import { normalizeContactPayload } from "./linkedin-helpers.mjs";

await import("./contact-info.js");

const command = getRegistry().get("linkedin/contact-info");
const PROFILE_URL = "https://www.linkedin.com/in/avery-example/";
const CONTACT_URL = `${PROFILE_URL}overlay/contact-info/`;
const COMMAND_TIMEOUT_MS = 60_000;

const PANEL = {
  current_url: CONTACT_URL,
  dialog_found: true,
  auth_wall: false,
  restricted: false,
  sections: [
    {
      heading: "Email",
      icon: "envelope-medium",
      blocks: ["avery@example.com"],
      lines: [],
      links: [
        {
          text: "avery@example.com",
          href: "mailto:avery@example.com",
          context: "avery@example.com",
        },
      ],
    },
  ],
};

/**
 * A LinkedIn page double on a simulated clock. Every browser call advances the clock by what it
 * would cost in the worst case, so a test can check the command's total time against OpenCLI's
 * command timeout. `gotoMs` is a number, or a function of the target URL. `panelOn` lists the states that show a Contact info section: "inline" (on the
 * profile page), "click" (after the link is clicked), and "overlay" (on the overlay URL).
 */
function linkedInPage(
  t,
  { panelOn = [], linkCount = 1, clickError = null, gotoMs = 3_000, callMs = 200 } = {},
) {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const calls = [];
  let url = "about:blank";
  let clicked = false;
  const spend = (ms) => t.mock.timers.tick(ms);
  const panelVisible = () =>
    (panelOn.includes("inline") && url === PROFILE_URL) ||
    (panelOn.includes("click") && clicked && url === PROFILE_URL) ||
    (panelOn.includes("overlay") && url === CONTACT_URL);
  const extraction = () =>
    panelVisible()
      ? { ...PANEL, current_url: url }
      : {
          current_url: url,
          dialog_found: false,
          auth_wall: false,
          restricted: false,
          sections: [],
        };

  return {
    calls,
    elapsed: () => Date.now(),
    async goto(target) {
      calls.push(["goto", target]);
      spend(typeof gotoMs === "function" ? gotoMs(target) : gotoMs);
      url = target;
      clicked = false;
    },
    async click(selector, options) {
      calls.push(["click", selector, options]);
      spend(callMs);
      if (clickError) throw clickError;
      clicked = true;
    },
    async wait(options) {
      calls.push(["wait", options]);
      if (typeof options === "number") return spend(options * 1000);
      if (options.selector === "main, dialog[data-testid=dialog], [role=dialog]") {
        return spend(callMs);
      }
      if (panelVisible()) return spend(callMs);
      spend(options.timeout * 1000);
      throw new Error(`Selector not found: ${options.selector}`);
    },
    async evaluate(source) {
      spend(callMs);
      if (source.includes("getBoundingClientRect")) {
        calls.push(["link"]);
        return { count: linkCount, index: linkCount > 1 ? 1 : 0 };
      }
      if (source.startsWith("Boolean")) {
        calls.push(["link"]);
        return linkCount > 0;
      }
      if (source.includes("lazy-column")) {
        const waitMs = Number(source.match(/var waitMs = (\d+);/)?.[1] ?? 0);
        calls.push(["extract", waitMs]);
        if (!panelVisible()) spend(waitMs);
        return extraction();
      }
      if (source.includes("unavailable_reason")) {
        return {
          current_url: url,
          name: "Avery Example",
          auth_wall: false,
          unavailable: false,
          unavailable_reason: "",
        };
      }
      throw new Error(`unexpected evaluate: ${source.slice(0, 60)}`);
    },
  };
}

test("a Contact info link that opens nothing returns contact_info_unavailable before the command timeout", async (t) => {
  // At 20s per navigation, the profile load, every panel wait, and the overlay navigation cannot
  // all fit in OpenCLI's 60s command timeout, so the reader has to skip what no longer fits.
  const page = linkedInPage(t, { gotoMs: 20_000 });
  const rows = await command.func(page, { profile: "avery-example" });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "contact_info_unavailable");
  assert.equal(rows[0].profile_id, "avery-example");
  assert.ok(
    page.elapsed() < COMMAND_TIMEOUT_MS,
    `contact-info took ${page.elapsed()}ms of simulated browser time`,
  );
  assert.ok(page.calls.some(([name]) => name === "click"));
});

/** The error OpenCLI's click throws when its selector does not resolve to one element. */
function targetError(code) {
  return Object.assign(new Error(`CSS selector "a[href*=\\"/overlay/contact-info\\"]": ${code}`), {
    name: "TargetError",
    code,
  });
}

test("a failed click falls back to the overlay URL and reports a missing section as a status row", async (t) => {
  const page = linkedInPage(t, { clickError: targetError("selector_ambiguous") });
  const rows = await command.func(page, { profile: "avery-example" });

  assert.deepEqual(
    rows.map((row) => row.status),
    ["contact_info_unavailable"],
  );
  assert.deepEqual(
    page.calls.filter(([name]) => name === "goto").map(([, target]) => target),
    [PROFILE_URL, CONTACT_URL],
  );
  assert.ok(page.elapsed() < COMMAND_TIMEOUT_MS);
});

test("the opener stops before the overlay navigation when the deadline cannot fit it", async (t) => {
  const page = linkedInPage(t, { panelOn: ["overlay"] });
  await page.goto(PROFILE_URL);
  const deadline = Date.now() + 15_000;
  const payload = await openLinkedInContactSection(page, CONTACT_URL, { deadline });

  assert.equal(payload.dialog_found, false);
  assert.equal(payload.timed_out, true);
  assert.ok(Date.now() <= deadline);
  assert.equal(page.calls.filter(([name]) => name === "goto").length, 1);
  const [row] = normalizeContactPayload(payload, { identifier: "avery-example" });
  assert.equal(row.status, "contact_info_unavailable");
  assert.match(row.message, /time limit/);
});

test("a section already on the profile page is read without clicking or navigating", async (t) => {
  const page = linkedInPage(t, { panelOn: ["inline"] });
  const rows = await command.func(page, { profile: "avery-example" });

  assert.deepEqual(
    rows.map(({ status, type, value }) => ({ status, type, value })),
    [{ status: "available", type: "email", value: "avery@example.com" }],
  );
  assert.deepEqual(
    page.calls.filter(([name]) => name !== "wait").map(([name]) => name),
    ["goto", "extract"],
  );
});

test("the visible Contact info link is clicked by index when several match", async (t) => {
  const page = linkedInPage(t, { panelOn: ["click"], linkCount: 2 });
  const rows = await command.func(page, { profile: "avery-example" });

  assert.equal(rows[0].status, "available");
  assert.deepEqual(
    page.calls.find(([name]) => name === "click"),
    ["click", 'a[href*="/overlay/contact-info"]', { nth: 1 }],
  );
  assert.equal(page.calls.filter(([name]) => name === "goto").length, 1);
});

test("navigation failures keep their error type instead of becoming contact statuses", async (t) => {
  const { BrowserConnectError } = await import("@jackwener/opencli/errors");
  const page = linkedInPage(t, { linkCount: 0 });
  const goto = page.goto;
  page.goto = async (target) => {
    if (target === CONTACT_URL) throw new BrowserConnectError("Browser Bridge disconnected");
    return goto(target);
  };

  await assert.rejects(command.func(page, { profile: "avery-example" }), BrowserConnectError);
});

test("the opener skips an overlay navigation that the CDP page's 31s navigation would carry past the deadline", async (t) => {
  // OpenCLI 1.8.8's CDP page waits up to 30s for the load event and 1s for the DOM to settle.
  const page = linkedInPage(t, {
    panelOn: ["overlay"],
    gotoMs: (target) => (target === CONTACT_URL ? 31_000 : 3_000),
  });
  await page.goto(PROFILE_URL);
  const deadline = Date.now() + 34_000;
  const payload = await openLinkedInContactSection(page, CONTACT_URL, { deadline });

  assert.equal(payload.timed_out, true);
  assert.ok(Date.now() <= deadline, `the opener ran ${Date.now() - deadline}ms past its deadline`);
  assert.equal(page.calls.filter(([name]) => name === "goto").length, 1);
});

test("browser and transport failures during the click propagate instead of becoming statuses", async (t) => {
  const disconnected = linkedInPage(t, {
    clickError: new BrowserConnectError("Browser Bridge disconnected"),
  });
  await assert.rejects(
    command.func(disconnected, { profile: "avery-example" }),
    BrowserConnectError,
  );
  assert.ok(
    !disconnected.calls.some(([name, target]) => name === "goto" && target === CONTACT_URL),
  );

  t.mock.timers.reset();
  const unknownOutcome = Object.assign(
    new Error("Browser command timed out client-side; the page may still have applied it."),
    { name: "BrowserCommandError", code: "command_result_unknown" },
  );
  const lost = linkedInPage(t, { clickError: unknownOutcome });
  await assert.rejects(command.func(lost, { profile: "avery-example" }), (error) => {
    assert.ok(error instanceof CommandExecutionError);
    assert.equal(error.cause, unknownOutcome);
    return true;
  });
});
