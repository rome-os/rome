import type { APIRequestContext, Page } from "@playwright/test";
import { control, TELEGRAM_BOTS, type TelegramChat, type TelegramPerson } from "../control";
import { expect, startChat } from "../fixtures";

// The people, chats and connections the upgrade fixture and the gap captures
// share, and the waits that go with them.

export const GUARDIAN_TG: TelegramPerson = {
  id: 5000001,
  first_name: "Gina",
  username: "gina_guardian",
};
export const STRANGER_TG: TelegramPerson = { id: 5000002, first_name: "Iris", username: "iris_k" };
export const DM_GUARDIAN: TelegramChat = { id: GUARDIAN_TG.id, type: "private" };
/** A basic group: each bot numbers its messages on its own. */
export const BASIC_GROUP: TelegramChat = {
  id: -4001234567,
  type: "group",
  title: "Fixture family",
};
/** A supergroup: the group numbers messages once for every bot. */
export const SUPERGROUP: TelegramChat = {
  id: -1002003004005,
  type: "supergroup",
  title: "Fixture team",
};

export const { alpha, beta } = TELEGRAM_BOTS;

/** Mutations the dashboard makes carry Fetch Metadata; so do these. */
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

export async function api<T>(
  request: APIRequestContext,
  method: "POST" | "PUT",
  path: string,
  data: unknown,
) {
  const res = await request.fetch(path, { method, data, headers: SAME_ORIGIN });
  if (!res.ok()) throw new Error(`${method} ${path} answered ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function telegramReplied(bot: string, chatId: number, text: string): Promise<number> {
  let id = 0;
  await expect
    .poll(
      async () => {
        const sent = (await control.telegramMessages()).find(
          (m) => m.bot === bot && m.chatId === chatId && m.from === bot && m.text === text,
        );
        id = sent?.messageId ?? 0;
        return id;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  return id;
}

export async function wechatReplied(text: string): Promise<void> {
  await expect
    .poll(async () => (await control.wechatMessages()).map((m) => m.text), { timeout: 60_000 })
    .toContain(text);
}

export async function dashboardChat(page: Page, first: string, reply: string) {
  const id = await startChat(page, first);
  await expect(page.getByText(reply)).toBeVisible();
  return id;
}

/** Connects WeChat and both Telegram bots, each answering as main, with the
 *  guardian's Telegram user linked to the guardian. */
export async function connectChannels(page: Page): Promise<void> {
  await page.goto("/settings/connections/wechat");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Your WeChat account is linked as guardian.")).toBeVisible();

  // The first bot through the Settings form, the second as another account.
  await page.goto("/settings/connections/telegram");
  await page.getByRole("button", { name: "Connect" }).first().click();
  await page.getByLabel("Telegram bot token").fill(alpha.token);
  await page.getByRole("button", { name: "Continue" }).first().click();
  const telegramAccounts = () =>
    control.sql<{ platform_account_id: string }>(
      "select platform_account_id from channels where platform = 'telegram'",
    );
  await expect.poll(async () => (await telegramAccounts()).length).toBe(1);
  const setup = await api<{ cid: string }>(
    page.request,
    "POST",
    "/api/connections/telegram/grants/bot/setup",
    {
      another: true,
    },
  );
  await api(page.request, "POST", `/api/setups/${setup.cid}/input`, {
    answers: { token: beta.token },
  });

  // Each bot answers as main, and the guardian's Telegram user is theirs.
  const channels = await control.sql<{ connection_id: string; platform_account_id: string }>(
    "select connection_id, platform_account_id from channels where platform = 'telegram'",
  );
  expect(channels.map((c) => c.platform_account_id).sort()).toEqual([alpha.id, beta.id]);
  for (const { connection_id } of channels)
    await api(page.request, "PUT", `/api/accounts/${connection_id}/agent`, { agent: "main" });
  await api(page.request, "POST", "/api/people/e2e-guardian/accounts", {
    channel: "telegram",
    channelUserId: String(GUARDIAN_TG.id),
  });
}
