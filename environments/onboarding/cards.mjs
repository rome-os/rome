// Walks the chat cards an agent waits on, in the Rome that walk.mjs signed up
// for, once env.sh has installed the Fake Service app in it:
// - core's connect card: the agent shows it, Dismiss answers it, and the
//   agent's next turn follows;
// - Fake Service's card, an app's card: Connect opens Fake Service's sign-in on
//   the OAuth test server, the walk signs in, I've authorized answers the
//   agent, and the agent's next turn follows;
// - for each kind in TEST_APPS, a real provider's test app in Rome Cloud,
//   Connect reaches that provider's authorization page. Signing in there is a
//   person's step, so the walk stops.
// Fails on the first step that does not happen. Screenshots land in $OUT.
import { chromium } from "playwright";

const cloud = process.env.CLOUD_ORIGIN;
const rome = process.env.ROME_ORIGIN;
const model = process.env.MODEL;
const out = process.env.OUT ?? ".";
const testApps = (process.env.TEST_APPS ?? "").split(",").filter(Boolean);
const oauthHost = new URL(process.env.OAUTH_ORIGIN).hostname;

const PROVIDER_HOSTS = {
  github: /(^|\.)github\.com$/,
  slack: /(^|\.)slack\.com$/,
  shopify: /(^|\.)(shopify|myshopify)\.com$/,
};
const KIND_NAMES = { github: "GitHub", slack: "Slack", shopify: "Shopify" };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
let shot = 0;

async function step(name, action) {
  process.stdout.write(`cards: ${name} ... `);
  try {
    await action();
  } catch (error) {
    await page.screenshot({ path: `${out}/cards-failed.png` }).catch(() => {});
    console.log("failed");
    console.error(error.message);
    await browser.close();
    process.exit(1);
  }
  shot += 1;
  await page.screenshot({ path: `${out}/cards-${String(shot).padStart(2, "0")}-${name}.png` });
  console.log("ok");
}

let chatId;
// Sends `text` in the open chat and returns the card titled `title` that the
// agent shows in reply.
async function ask(text, title) {
  const sent = page.waitForResponse(
    (res) =>
      /\/api\/chat\/sessions\/[^/]+\/turns$/.test(new URL(res.url()).pathname) &&
      res.request().method() === "POST",
    { timeout: 30_000 },
  );
  const composer = page.locator("textarea").last();
  await composer.fill(text);
  await composer.press("Enter");
  chatId = decodeURIComponent(new URL((await sent).url()).pathname.split("/")[4]);
  const card = page.locator("[aria-busy]").filter({ hasText: title }).last();
  await card.getByRole("button", { name: "Dismiss" }).waitFor({ timeout: 180_000 });
  return card;
}

// Presses `label` on `card` and returns core's reply to the press.
async function press(card, label) {
  const replied = page.waitForResponse(
    (res) => /\/api\/chat\/widgets\/[^/]+\/events$/.test(new URL(res.url()).pathname),
    { timeout: 30_000 },
  );
  await card.getByRole("button", { name: label }).click();
  const res = await replied;
  if (!res.ok()) throw new Error(`pressing ${label} answered ${res.status()}: ${await res.text()}`);
  return res.json();
}

// Opens the page a Connect press returned, in a new tab, as the client does.
async function openConnect(reply) {
  if (typeof reply.open !== "string") throw new Error(`Connect opened nothing: ${JSON.stringify(reply)}`);
  const tab = await context.newPage();
  await tab.goto(new URL(reply.open, page.url()).href, { timeout: 60_000 });
  return tab;
}

await step("sign-in", async () => {
  await page.goto(`${cloud}/api/auth/dev/start`, { timeout: 120_000 });
  await page.goto(rome, { timeout: 120_000 });
  await page.getByRole("button", { name: "Continue with Rome Cloud" }).click();
  await page.getByText("Main chat").first().waitFor({ timeout: 90_000 });
});

await step("model", async () => {
  const status = await page.evaluate(async (model) => {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tierModelMappings: { anthropic: { large: model, medium: model, small: model } },
      }),
    });
    return res.status;
  }, model);
  if (status >= 300) throw new Error(`setting the model answered ${status}`);
});

// The Concierge has a connect card of its own, so the walk asks in Chat,
// where the agent connects through `connect_account`.
await step("chat-mode", async () => {
  const modes = page.getByLabel("Chat list mode");
  const chat = { name: "Chat", exact: true };
  await modes
    .getByRole("radio", chat)
    .or(modes.getByRole("button", chat))
    .or(modes.getByRole("tab", chat))
    .first()
    .click();
  await page.getByText("New chat", { exact: true }).click();
});

await step("core-card-shown", async () => {
  await ask("Connect my GitHub account.", "Connect GitHub");
});

await step("core-card-answered", async () => {
  const card = page.locator("[aria-busy]").filter({ hasText: "Connect GitHub" }).last();
  const reply = await press(card, "Dismiss");
  if (reply.answered !== true) throw new Error(`Dismiss did not answer the agent: ${JSON.stringify(reply)}`);
  await agentResumed();
});

await step("fake-service-card-shown", async () => {
  await ask("Connect Fake Service.", "Connect Fake Service");
});

await step("fake-service-connected", async () => {
  const card = page.locator("[aria-busy]").filter({ hasText: "Connect Fake Service" }).last();
  const tab = await openConnect(await press(card, "Connect"));
  await tab.waitForURL((url) => url.hostname === oauthHost, { timeout: 60_000 });
  await tab.screenshot({ path: `${out}/cards-fake-service-sign-in.png` });
  await tab.locator("input[name=username]").fill("rome-test");
  await tab.locator("input[type=submit], button[type=submit]").first().click();
  await tab.getByText("Fake Service is connected").waitFor({ timeout: 60_000 });
  await tab.screenshot({ path: `${out}/cards-fake-service-connected.png` });
  await tab.close();
  const reply = await press(card, "I've authorized");
  if (reply.answered !== true) throw new Error(`I've authorized did not answer: ${JSON.stringify(reply)}`);
  await agentResumed();
});

for (const kind of testApps) {
  await step(`connect-${kind}`, async () => {
    const card = await ask(`Connect my ${KIND_NAMES[kind]} account.`, `Connect ${KIND_NAMES[kind]}`);
    const tab = await openConnect(await press(card, "Connect"));
    await tab.waitForURL((url) => PROVIDER_HOSTS[kind].test(url.hostname), { timeout: 60_000 });
    await tab.screenshot({ path: `${out}/cards-provider-${kind}.png` });
    await tab.close();
  });
}

await browser.close();

// Waits for the agent's turn after the card's latest answer: an assistant
// message with text, after the message that carries the answer.
async function agentResumed() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const res = await page.request.get(
      new URL(`/api/chat/sessions/${encodeURIComponent(chatId)}/messages`, page.url()).href,
    );
    if (res.ok()) {
      const messages = listOf(await res.json());
      const answeredAt = messages.findLastIndex((m) =>
        partsOf(m).some((p) => p?.type === "interaction_result"),
      );
      const replied = messages
        .slice(answeredAt + 1)
        .some(
          (m) =>
            m.role === "assistant" &&
            partsOf(m).some((p) => p?.type === "text" && (p.content ?? p.text)?.trim()),
        );
      if (answeredAt >= 0 && replied) return;
    }
    await page.waitForTimeout(3_000);
  }
  throw new Error("the agent never took a turn after the answer");
}

function listOf(body) {
  if (Array.isArray(body)) return body;
  return body?.messages ?? [];
}

function partsOf(message) {
  if (Array.isArray(message.parts)) return message.parts;
  try {
    const parts = JSON.parse(message.content);
    return Array.isArray(parts) ? parts : [];
  } catch {
    return [];
  }
}
