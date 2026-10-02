import { chromium } from "@playwright/test";
// PROTOTYPE ONLY. Drives every variant through the scenarios and saves screenshots.
// With `pnpm start:web:mock` running: node mock/prototype-background-tasks/prototype-screenshots.mjs
const base = `${process.env.BASE_URL ?? "http://localhost:3200"}/chat/mock-chat-market-brief`;
const out = process.env.OUT_DIR ?? new URL("./screenshots", import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
const scrollBottom = () =>
  page.evaluate(() =>
    document.querySelectorAll(".overflow-y-auto").forEach((el) => (el.scrollTop = el.scrollHeight)),
  );
const has = async (text) => (await page.getByText(text, { exact: false }).count()) > 0;
const click = (name) => page.getByRole("button", { name, exact: false }).first().click();
const report = [];
for (const v of ["A", "B", "C"]) {
  await page.goto(`${base}?variant=${v}`);
  await page.waitForSelector("text=PROTOTYPE variant", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await scrollBottom();
  if (v === "A") await page.getByText("running in the background").first().click();
  if (v === "B") await page.getByRole("button", { name: /3 running/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${v}-1-running.png` });
  report.push(
    `${v} running: tray=${await has("running in the background")} pill=${await has("3 running")} cards=${await has("kept alive up to")} stop=${await page.getByRole("button", { name: /Stop/ }).count()}`,
  );
  if (v === "B") await page.keyboard.press("Escape");
  // A task finishes while idle: Rome starts a turn by itself.
  await click("Tests pass (while idle)");
  await page.waitForTimeout(4500);
  await scrollBottom();
  await page.screenshot({ path: `${out}/${v}-2-tests-finished.png` });
  report.push(
    `${v} finished: marker=${await has("Background task finished · Unit tests")} startedByRome=${await has("Started by Rome")} reply=${await has("4,799 passed")}`,
  );
  // A task finishes while Rome answers you: its result is queued.
  await click("Reset");
  await page.waitForTimeout(300);
  await click("You send a message, tests finish mid-reply");
  await page.waitForTimeout(1300);
  await scrollBottom();
  if (v === "B") {
    await page
      .getByRole("button", { name: /running/ })
      .first()
      .click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${out}/${v}-3-result-queued.png` });
  report.push(
    `${v} queued: queuedBadge=${(await has("result queued")) || (await has("Result queued")) || (await has("A finished task is queued"))}`,
  );
  if (v === "B") await page.keyboard.press("Escape");
  await page.waitForTimeout(6000);
  await scrollBottom();
  report.push(`${v} after queue: reply=${await has("4,799 passed")}`);
  await click("Reset");
  await page.waitForTimeout(300);
}
// Silent option + no Stop button, shown on variant A.
await page.goto(`${base}?variant=A`);
await page.waitForSelector("text=PROTOTYPE variant");
await click("may stay silent");
await click("without");
await click("Preview server exits cleanly");
await page.waitForTimeout(2500);
await scrollBottom();
await page.getByText("running in the background").first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/A-4-silent-no-stop.png` });
report.push(
  `silent: nothingNeeds=${await has("Nothing needs your attention")} stopButtons=${await page.getByRole("button", { name: /^Stop$/ }).count()}`,
);
await click("Idle cap reached");
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/A-5-idle-cap.png` });
report.push(`idle cap: stoppedText=${await has("chat idle too long")}`);
console.log(report.join("\n"));
console.log("errors:", errors.length ? errors.slice(0, 8).join("\n") : "none");
await browser.close();
