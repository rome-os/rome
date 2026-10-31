import { type APIRequestContext, type Page } from "@playwright/test";
import { control, TELEGRAM_BOTS, type TelegramChat, type TelegramPerson } from "../control";
import { chatRow, expect, openChatActions, send, startChat, test } from "../fixtures";

// Seeds the upgrade fixture by using an older Rome the way a guardian did:
// dashboard chats, WeChat, and two Telegram bots in DMs, a basic group and a
// supergroup. Run it only against the Rome whose data the fixture stands for
// (see README.md, "The upgrade fixture"). It ends by saving the home to
// E2E_FIXTURE_OUT with a manifest of what each chat holds.

test.skip(!process.env.E2E_FIXTURE_OUT, "Set E2E_FIXTURE_OUT to seed the upgrade fixture");
test.describe.configure({ mode: "serial" });

const GUARDIAN_TG: TelegramPerson = { id: 5000001, first_name: "Gina", username: "gina_guardian" };
const STRANGER_TG: TelegramPerson = { id: 5000002, first_name: "Iris", username: "iris_k" };
const DM_GUARDIAN: TelegramChat = { id: GUARDIAN_TG.id, type: "private" };
/** A basic group: each bot numbers its messages on its own. */
const BASIC_GROUP: TelegramChat = { id: -4001234567, type: "group", title: "Fixture family" };
/** A supergroup: the group numbers messages once for every bot. */
const SUPERGROUP: TelegramChat = { id: -1002003004005, type: "supergroup", title: "Fixture team" };

const { alpha, beta } = TELEGRAM_BOTS;

/** Mutations the dashboard makes carry Fetch Metadata; so do these. */
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

async function api<T>(
  request: APIRequestContext,
  method: "POST" | "PUT",
  path: string,
  data: unknown,
) {
  const res = await request.fetch(path, { method, data, headers: SAME_ORIGIN });
  if (!res.ok()) throw new Error(`${method} ${path} answered ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function telegramReplied(bot: string, chatId: number, text: string): Promise<number> {
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

async function wechatReplied(text: string): Promise<void> {
  await expect
    .poll(async () => (await control.wechatMessages()).map((m) => m.text), { timeout: 60_000 })
    .toContain(text);
}

async function dashboardChat(page: Page, first: string, reply: string) {
  const id = await startChat(page, first);
  await expect(page.getByText(reply)).toBeVisible();
  return id;
}

const manifest: Record<string, unknown> = {};

test("connects WeChat and two Telegram bots", async ({ page }) => {
  await page.goto("/settings/connections/wechat");
  await page.getByRole("button", { name: "Connect" }).click();
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
});

test("seeds dashboard chats", async ({ page }) => {
  // Two turns, in order.
  manifest.plain = await dashboardChat(
    page,
    "Fixture plain E2E-REPLY fxplain1",
    "Reply to fxplain1",
  );
  await send(page, "And again E2E-REPLY fxplain2");
  await expect(page.getByText("Reply to fxplain2")).toBeVisible();

  // A subagent run under the chat's turn.
  manifest.subagent = await dashboardChat(
    page,
    "Fixture delegate E2E-SUBAGENT fxsub",
    "Parent done fxsub",
  );

  // Renamed.
  manifest.renamed = await dashboardChat(
    page,
    "Fixture rename E2E-REPLY fxrename",
    "Reply to fxrename",
  );
  await expect(chatRow(page, "Topic fxrename")).toBeVisible();
  await openChatActions(page, "Topic fxrename");
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Chat name" }).fill("Renamed fxrename");
  await page.getByRole("textbox", { name: "Chat name" }).press("Enter");
  await expect(chatRow(page, "Renamed fxrename")).toBeVisible();

  // Archived.
  manifest.archived = await dashboardChat(
    page,
    "Fixture archive E2E-REPLY fxarchive",
    "Reply to fxarchive",
  );
  await expect(chatRow(page, "Topic fxarchive")).toBeVisible();
  await openChatActions(page, "Topic fxarchive");
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.goto("/chat");
  await expect(chatRow(page, "Topic fxarchive")).toHaveCount(0);

  // Unread: the reply lands while the guardian is elsewhere.
  manifest.unread = await startChat(page, "Fixture unread E2E-SLOW fxunread");
  await page.getByRole("link", { name: "New chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(
    chatRow(page, "Topic fxunread").getByRole("img", { name: "Done · new replies" }),
  ).toBeVisible();
});

test("seeds a WeChat chat", async () => {
  await control.wechatSays("Fixture wechat E2E-REPLY fxwx1");
  await wechatReplied("Reply to fxwx1");
  await control.wechatSays("Fixture wechat again E2E-REPLY fxwx2");
  await wechatReplied("Reply to fxwx2");
});

test("seeds Telegram DMs with each bot", async () => {
  await control.telegramSays({
    chat: DM_GUARDIAN,
    from: GUARDIAN_TG,
    text: "Fixture dm E2E-REPLY fxtgdm1",
    bots: [alpha.username],
  });
  await telegramReplied(alpha.username, DM_GUARDIAN.id, "Reply to fxtgdm1");
  await control.telegramSays({
    chat: DM_GUARDIAN,
    from: GUARDIAN_TG,
    text: "Fixture dm again E2E-REPLY fxtgdm2",
    bots: [alpha.username],
  });
  await telegramReplied(alpha.username, DM_GUARDIAN.id, "Reply to fxtgdm2");
  await control.telegramSays({
    chat: DM_GUARDIAN,
    from: GUARDIAN_TG,
    text: "Fixture beta dm E2E-REPLY fxtgbeta",
    bots: [beta.username],
  });
  await telegramReplied(beta.username, DM_GUARDIAN.id, "Reply to fxtgbeta");
});

for (const group of [BASIC_GROUP, SUPERGROUP]) {
  const tag = group.type === "group" ? "basic" : "super";
  test(`seeds a Telegram ${group.type} that both bots are in`, async () => {
    const both = [alpha.username, beta.username];
    await control.telegramSays({
      chat: group,
      from: GUARDIAN_TG,
      text: `@${alpha.username} Fixture ${tag} E2E-REPLY fx${tag}1`,
      bots: both,
      mention: alpha.username,
    });
    const alphaReply = await telegramReplied(alpha.username, group.id, `Reply to fx${tag}1`);
    await control.telegramSays({
      chat: group,
      from: GUARDIAN_TG,
      text: `@${beta.username} Fixture ${tag} E2E-REPLY fx${tag}2`,
      bots: both,
      mention: beta.username,
    });
    await telegramReplied(beta.username, group.id, `Reply to fx${tag}2`);
    // Said to nobody: each bot records it, neither answers.
    await control.telegramSays({
      chat: group,
      from: STRANGER_TG,
      text: `Fixture ${tag} ambient fx${tag}3`,
      bots: both,
    });
    // A reply to alpha's answer addresses alpha.
    await control.telegramSays({
      chat: group,
      from: GUARDIAN_TG,
      text: `Fixture ${tag} follow-up E2E-REPLY fx${tag}4`,
      bots: both,
      replyTo: { bot: alpha.username, messageId: alphaReply },
    });
    await telegramReplied(alpha.username, group.id, `Reply to fx${tag}4`);
  });
}

test("saves the fixture", async () => {
  // Let background turns (titles, notifications) settle before the snapshot.
  await new Promise((done) => setTimeout(done, 5_000));
  const sessions = await control.sql(
    `select id, type, source_channel, source_thread_id, source_thread_type, source_thread_name,
            parent_session_id, agent_name, name
     from rome_sessions order by created_at, id`,
  );
  const messages = await control.sql(
    `select id, session_id, role, sender_id, sender_name, platform_message_id,
            reply_to_platform_message_id, turn_id, context_injected_turn_id,
            content
     from rome_agent_messages where role <> 'trace' order by created_at, rowid`,
  );
  const platformIds = await control.sql("select * from rome_agent_message_platform_ids");
  const channels = await control.sql(
    "select id, connection_kind, platform, platform_account_id from channels",
  );
  const telegram = await control.telegramMessages();
  const wechat = await control.wechatMessages();
  expect(await control.unhandled()).toEqual({ model: [], wechat: [], telegram: [] });
  await control.saveFixture(process.env.E2E_FIXTURE_OUT!, {
    seededAt: new Date().toISOString(),
    romeCommit: process.env.E2E_FIXTURE_COMMIT ?? null,
    dashboardChats: manifest,
    legacy: { channels, sessions, messages, platformIds },
    platforms: { telegram, wechat },
  });
});
