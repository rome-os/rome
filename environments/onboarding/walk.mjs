// Walks onboarding the way a new user does: the Rome Cloud landing page, sign-up,
// the onboarding questions, the Rome booting, and opening the Rome's chat.
// Fails on the first step that does not happen. Screenshots land in $OUT.
import { chromium } from "playwright";

const cloud = process.env.CLOUD_ORIGIN;
const domain = process.env.ROME_DOMAIN;
const out = process.env.OUT ?? ".";
const address = "onboarding-walk";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
let shot = 0;

async function step(name, action) {
  process.stdout.write(`walk: ${name} ... `);
  try {
    await action();
  } catch (error) {
    await page.screenshot({ path: `${out}/failed.png` }).catch(() => {});
    console.log("failed");
    console.error(error.message);
    await browser.close();
    process.exit(1);
  }
  shot += 1;
  await page.screenshot({ path: `${out}/${String(shot).padStart(2, "0")}-${name}.png` });
  console.log("ok");
}

await step("landing", async () => {
  await page.goto(cloud, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByRole("link", { name: "Get started" }).first().click();
  await page.waitForURL(/\/register/, { timeout: 60_000 });
});

await step("questions", async () => {
  const form = page.locator("form").first();
  // The number of questions depends on earlier answers, so walk until the last one.
  await page.getByText(/^1 of \d+$/).waitFor();
  await form.locator("input").first().fill(address);
  for (let question = 1; question <= 12; question++) {
    const inputs = form.locator("input[type=text], input:not([type]), textarea");
    for (let i = 0; i < (await inputs.count()); i++) {
      const input = inputs.nth(i);
      if ((await input.isVisible()) && !(await input.inputValue())) await input.fill("Walk");
    }
    const choices = form.locator("[role=radio], input[type=radio], [role=option]");
    if (await choices.count()) await choices.first().click({ force: true });
    const next = page.getByRole("button", { name: /^(Continue|Create your Rome)$/ }).last();
    const label = await next.innerText();
    await next.click();
    if (label === "Create your Rome") break;
  }
});

// After sign-up the user either watches the Rome boot and is taken into it, or
// lands on the dashboard and opens it there. Either way the walk ends in the
// Rome's chat.
const romeOrigin = new RegExp(`^https://${address}\\.${domain.replaceAll(".", "\\.")}/`);

await step("rome-chat", async () => {
  const deadline = Date.now() + 10 * 60_000;
  while (!romeOrigin.test(page.url())) {
    if (Date.now() > deadline) throw new Error(`never reached the Rome; last at ${page.url()}`);
    const open = page.getByRole("link", { name: "Open Rome" });
    if (await open.isVisible().catch(() => false)) {
      // The link may open a new tab, so follow its address in this one.
      await page.goto(await open.getAttribute("href"));
    } else {
      await page.waitForTimeout(3_000);
    }
  }
  await page.getByText("Main chat").first().waitFor({ timeout: 60_000 });
});

await browser.close();
