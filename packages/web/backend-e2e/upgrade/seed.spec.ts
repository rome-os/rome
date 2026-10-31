import { control } from "../control";
import { chatRow, expect, openChatActions, send, startChat, test } from "../fixtures";
import {
  BASIC_GROUP,
  DM_GUARDIAN,
  GUARDIAN_TG,
  STRANGER_TG,
  SUPERGROUP,
  alpha,
  beta,
  connectChannels,
  dashboardChat,
  telegramReplied,
  wechatReplied,
} from "./world";

// Seeds the upgrade fixture by using an older Rome the way a guardian did:
// dashboard chats, WeChat, and two Telegram bots in DMs, a basic group and a
// supergroup. Run it only against the Rome whose data the fixture stands for
// (see README.md, "The upgrade fixture"). It ends by saving the home to
// E2E_FIXTURE_OUT with a manifest of what each chat holds.

test.skip(!process.env.E2E_FIXTURE_OUT, "Set E2E_FIXTURE_OUT to seed the upgrade fixture");
test.describe.configure({ mode: "serial" });

const manifest: Record<string, unknown> = {};

test("connects WeChat and two Telegram bots", async ({ page }) => {
  await connectChannels(page);
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
