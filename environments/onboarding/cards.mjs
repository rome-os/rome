// Walks the chat cards an agent waits on, in the Rome walk.mjs signed up for:
// the agent shows core's connect card, the guardian presses it, and the agent's
// next turn carries the answer. Connect is pressed for each kind in TEST_APPS,
// which are the providers Rome Cloud can connect. On a real provider the walk
// stops at its authorization page, since signing in there is a person's step;
// on the fake GitHub it authorizes, and the agent's next turn must follow.
const PROVIDER_HOSTS = {
  github: /(^|\.)github\.com$/,
  slack: /(^|\.)slack\.com$/,
  shopify: /(^|\.)(shopify|myshopify)\.com$/,
};
const KIND_NAMES = { github: "GitHub", slack: "Slack", shopify: "Shopify" };

// The fake GitHub's address, when the environment runs one.
const fakeGithub = process.env.FAKE_GITHUB_ORIGIN ? new URL(process.env.FAKE_GITHUB_ORIGIN).hostname : null;

function providerHost(kind) {
  return kind === "github" && fakeGithub ? new RegExp(`^${fakeGithub.replaceAll(".", "\\.")}$`) : PROVIDER_HOSTS[kind];
}

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

  // The Concierge has a connect card of its own, so the walk asks in Chat,
  // where the agent connects through `connect_account`.
  await step("chat-mode", async () => {
    const modes = page.getByLabel("Chat list mode");
    const chat = { name: "Chat", exact: true };
    await modes.getByRole("radio", chat).or(modes.getByRole("button", chat)).or(modes.getByRole("tab", chat)).first().click();
    await page.getByText("New chat", { exact: true }).click();
    await page.waitForURL((url) => !/main/i.test(url.pathname), { timeout: 30_000 }).catch(() => {});
  });

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
      await provider.waitForURL((url) => providerHost(kind).test(url.hostname), { timeout: 60_000 });
      await provider.screenshot({ path: `${out}/provider-${kind}.png` });
      if (kind === "github" && fakeGithub) {
        // The fake GitHub signs nobody in, so the walk finishes the connection.
        await provider.getByRole("link", { name: "Authorize" }).click();
        await provider.waitForURL((url) => !providerHost(kind).test(url.hostname), { timeout: 60_000 });
        // The Rome's callback page redeems the connection, so let it finish.
        await provider.waitForTimeout(5_000);
        console.log(`\n  provider page ended at ${provider.url()}`);
        await provider.screenshot({ path: `${out}/provider-${kind}-done.png` });
        await provider.close();
        const checked = await press(card, "I've authorized");
        if (checked.answered !== true) throw new Error(`I've authorized did not answer: ${JSON.stringify(checked)}`);
        await agentResumed(page, chatId);
      } else {
        await provider.close();
      }
    });
  }
}

// Waits for the agent's turn after the card's latest answer: an assistant
// message with text, after the message that carries the answer.
async function agentResumed(page, chatId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const res = await page.request.get(
      new URL(`/api/chat/sessions/${encodeURIComponent(chatId)}/messages`, page.url()).href,
    );
    if (res.ok()) {
      const messages = listOf(await res.json());
      const answeredAt = messages.findLastIndex((m) => partsOf(m).some((p) => p?.type === "interaction_result"));
      if (
        answeredAt >= 0 &&
        messages
          .slice(answeredAt + 1)
          .some((m) => m.role === "assistant" && partsOf(m).some((p) => p?.type === "text" && (p.content ?? p.text)?.trim()))
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
