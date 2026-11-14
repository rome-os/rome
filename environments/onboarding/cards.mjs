// Walks the chat cards an agent waits on, in the Rome walk.mjs signed up for:
// the agent shows core's connect card, the guardian presses it, and the agent's
// next turn carries the answer. Connect is pressed for each kind in TEST_APPS,
// which are the test OAuth apps Rome Cloud holds; the walk stops at the
// provider's authorization page, since signing in there is a person's step.
const PROVIDER_HOSTS = {
  github: /(^|\.)github\.com$/,
  slack: /(^|\.)slack\.com$/,
  shopify: /(^|\.)(shopify|myshopify)\.com$/,
};
const KIND_NAMES = { github: "GitHub", slack: "Slack", shopify: "Shopify" };

export async function walkCards({ page, step, out }) {
  const model = process.env.MODEL;
  const testApps = (process.env.TEST_APPS ?? "").split(",").filter(Boolean);

  await step("cards-model", async () => {
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

  let chatId;
  // Asks the agent to connect `kind` and returns the card it shows.
  async function askToConnect(kind) {
    const name = KIND_NAMES[kind];
    const sent = page.waitForResponse(
      (res) => /\/api\/chat\/sessions\/[^/]+\/turns$/.test(new URL(res.url()).pathname) && res.request().method() === "POST",
      { timeout: 30_000 },
    );
    const composer = page.locator("textarea").last();
    await composer.fill(`Connect my ${name} account.`);
    await composer.press("Enter");
    chatId = decodeURIComponent(new URL((await sent).url()).pathname.split("/")[4]);
    const card = page.locator("[aria-busy]").filter({ hasText: `Connect ${name}` }).last();
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

  await step("card-shown", async () => {
    await askToConnect("github");
  });

  await step("card-answered", async () => {
    const card = page.locator("[aria-busy]").filter({ hasText: "Connect GitHub" }).last();
    const reply = await press(card, "Dismiss");
    if (reply.answered !== true) throw new Error(`Dismiss did not answer the agent: ${JSON.stringify(reply)}`);
    await agentResumed(page, chatId);
  });

  for (const kind of testApps) {
    await step(`card-connect-${kind}`, async () => {
      const card = await askToConnect(kind);
      const reply = await press(card, "Connect");
      if (typeof reply.open !== "string") throw new Error(`Connect opened nothing: ${JSON.stringify(reply)}`);
      const provider = await page.context().newPage();
      await provider.goto(new URL(reply.open, page.url()).href, { timeout: 60_000 });
      await provider.waitForURL((url) => PROVIDER_HOSTS[kind].test(url.hostname), { timeout: 60_000 });
      await provider.screenshot({ path: `${out}/provider-${kind}.png` });
      await provider.close();
    });
  }
}

// Waits for the agent's turn after the card's answer: an assistant message with
// text, after the message that carries the answer.
async function agentResumed(page, chatId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/chat/sessions/${encodeURIComponent(chatId)}/messages`);
    if (res.ok()) {
      const messages = listOf(await res.json());
      const answeredAt = messages.findIndex((m) => partsOf(m).some((p) => p?.type === "interaction_result"));
      if (
        answeredAt >= 0 &&
        messages
          .slice(answeredAt + 1)
          .some((m) => m.role === "assistant" && partsOf(m).some((p) => p?.type === "text" && p.text?.trim()))
      ) {
        return;
      }
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
