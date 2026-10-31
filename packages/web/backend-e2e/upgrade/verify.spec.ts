import { readFileSync } from "node:fs";
import { join } from "node:path";
import { control, TELEGRAM_BOTS, type TelegramChat } from "../control";
import { chatRow, expect, send, test } from "../fixtures";

// Checks a Rome booted on the upgrade fixture (E2E_FIXTURE): the data an older
// Rome wrote reads back the same after every migration in between, and the
// chats it holds keep working. The rest of the suite runs over the same
// upgraded home in the same run.

const fixture = process.env.E2E_FIXTURE;
test.skip(!fixture, "Set E2E_FIXTURE to boot on the upgrade fixture");
test.describe.configure({ mode: "default" });

interface LegacyMessage {
  id: string;
  session_id: string;
  role: string;
  sender_id: string | null;
  platform_message_id: string | null;
  reply_to_platform_message_id: string | null;
  content: string;
}
interface LegacySession {
  id: string;
  type: string;
  source_channel: string;
  source_thread_id: string;
  source_thread_type: string | null;
  parent_session_id: string | null;
  name: string | null;
}
interface Manifest {
  dashboardChats: Record<"plain" | "subagent" | "renamed" | "archived" | "unread", string>;
  legacy: {
    channels: Array<{ id: string; platform: string; platform_account_id: string }>;
    sessions: LegacySession[];
    messages: LegacyMessage[];
  };
}

const manifest = (
  fixture
    ? JSON.parse(readFileSync(join(fixture, "manifest.json"), "utf8"))
    : { dashboardChats: {}, legacy: { channels: [], sessions: [], messages: [] } }
) as Manifest;
const { legacy } = manifest;
const TRANSCRIPT_ROLES = new Set(["user", "assistant", "notification"]);

/** The text of a legacy row: the text blocks of its content. */
function textOf(content: string): string {
  try {
    const blocks = JSON.parse(content) as Array<{ type: string; content?: string }>;
    return blocks
      .filter((b) => b.type === "text")
      .map((b) => b.content)
      .join("\n");
  } catch {
    return content;
  }
}

const accountOfChannel = new Map(legacy.channels.map((c) => [c.id, c.platform_account_id]));
const chatSessions = legacy.sessions.filter((s) => s.type === "channel");

test.describe("data", () => {
  test("every chat session became one chat", async () => {
    const chats = await control.sql<{
      id: string;
      platform: string;
      platform_chat_id: string;
      kind: string;
      name: string | null;
    }>("select id, platform, platform_chat_id, kind, name from chats");
    const sessions = await control.sql<{
      id: string;
      chat_id: string | null;
      account_id: string | null;
    }>("select id, chat_id, account_id from rome_sessions");
    const chatOf = new Map(sessions.map((s) => [s.id, s.chat_id]));

    for (const session of chatSessions) expect(chatOf.get(session.id), session.id).toBeTruthy();
    // A subagent stands in no chat.
    for (const session of legacy.sessions.filter((s) => s.type === "subagent"))
      expect(chatOf.get(session.id), session.id).toBeNull();

    // Two bots in one group share its chat; one person's DMs with two bots do not.
    const byThread = new Map<string, Set<string>>();
    for (const session of chatSessions) {
      const key =
        session.source_channel === "webchat"
          ? session.id
          : `${session.source_thread_type}:${session.source_thread_id}:${session.source_thread_type === "private" ? session.source_channel : ""}`;
      const set = byThread.get(key) ?? new Set();
      set.add(chatOf.get(session.id)!);
      byThread.set(key, set);
    }
    for (const [key, ids] of byThread) expect(ids.size, key).toBe(1);
    const distinct = new Set([...byThread.values()].map((ids) => [...ids][0]));
    expect(distinct.size).toBe(byThread.size);
    expect(chats.length).toBeGreaterThanOrEqual(byThread.size);

    const groups = chats.filter((c) => c.kind === "group");
    expect(groups.map((c) => [c.platform, c.platform_chat_id, c.name]).sort()).toEqual([
      ["telegram", "-1002003004005", "Fixture team"],
      ["telegram", "-4001234567", "Fixture family"],
    ]);
    const renamed = chats.find((c) => c.id === chatOf.get(manifest.dashboardChats.renamed));
    expect(renamed?.name).toBe("Renamed fxrename");
  });

  test("every message a chat session held is in its chat, with its text", async () => {
    const rows = await control.sql<{
      id: string;
      chat_id: string;
      text: string;
      platform_message_id: string;
      reply_to_platform_message_id: string | null;
      sender_account_id: string | null;
    }>(
      "select id, chat_id, text, platform_message_id, reply_to_platform_message_id, sender_account_id from chat_messages",
    );
    const links = await control.sql<{
      message_id: string;
      session_id: string;
      role: string;
      turn_id: string | null;
    }>("select message_id, session_id, role, turn_id from agent_turn_messages");
    const sessions = await control.sql<{ id: string; chat_id: string | null }>(
      "select id, chat_id from rome_sessions",
    );
    const chatOf = new Map(sessions.map((s) => [s.id, s.chat_id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byPlatformId = new Map(rows.map((r) => [`${r.chat_id}\0${r.platform_message_id}`, r]));
    const linked = new Set(links.map((l) => `${l.session_id}\0${l.message_id}`));

    const sessionOf = new Map(legacy.sessions.map((s) => [s.id, s]));
    const missing: string[] = [];
    for (const message of legacy.messages) {
      const session = sessionOf.get(message.session_id);
      if (session?.type !== "channel" || !TRANSCRIPT_ROLES.has(message.role)) continue;
      const chat = chatOf.get(message.session_id)!;
      // A Telegram basic group numbers each bot's messages on its own, so its
      // ids carry the bot's account.
      const perAccount =
        session.source_thread_type === "group" &&
        /^-\d{1,12}$/.test(session.source_thread_id) &&
        !session.source_thread_id.startsWith("-100");
      const platformId =
        message.platform_message_id === null
          ? message.id
          : perAccount
            ? `${accountOfChannel.get(session.source_channel)}:${message.platform_message_id}`
            : message.platform_message_id;
      const row = byId.get(message.id) ?? byPlatformId.get(`${chat}\0${platformId}`);
      if (!row) {
        missing.push(`${message.role} ${message.id} (${textOf(message.content).slice(0, 40)})`);
        continue;
      }
      expect(row.chat_id, message.id).toBe(chat);
      expect(row.text, message.id).toBe(textOf(message.content));
      if (message.reply_to_platform_message_id)
        expect(row.reply_to_platform_message_id, message.id).toBe(
          perAccount
            ? `${accountOfChannel.get(session.source_channel)}:${message.reply_to_platform_message_id}`
            : message.reply_to_platform_message_id,
        );
      // A prompt and an answer stay linked to the session's turn.
      if (message.role !== "notification")
        expect(
          linked.has(`${message.session_id}\0${row.id}`),
          `${message.role} ${message.id} linked`,
        ).toBe(true);
    }
    expect(missing).toEqual([]);
  });

  test("the legacy copies are gone and subagents keep theirs", async () => {
    const left = await control.sql<{ n: number }>(
      `select count(*) as n from rome_agent_messages m join rome_sessions s on s.id = m.session_id
       where s.chat_id is not null and m.role in ('user', 'assistant', 'notification')`,
    );
    expect(left[0]!.n).toBe(0);
    const subagent = legacy.sessions.find((s) => s.type === "subagent")!;
    const kept = await control.sql<{ role: string }>(
      `select role from rome_agent_messages where session_id = '${subagent.id}' and role <> 'trace' order by created_at`,
    );
    expect(kept.map((r) => r.role)).toEqual(["user", "assistant"]);
    const tables = await control.sql<{ name: string }>(
      "select name from sqlite_master where type = 'table' and name = 'rome_agent_message_platform_ids'",
    );
    expect(tables).toEqual([]);
  });
});

test.describe("dashboard", () => {
  test("seeded chats are listed with their names and unread marks, and the archived one is not", async ({
    page,
  }) => {
    await page.goto("/chat");
    // The list pages; the rest of the suite may have added newer chats above.
    const more = page.getByText(/^Load \d+ more$/);
    await expect(chatRow(page, "Topic fxplain1").or(more).first()).toBeVisible();
    while (await more.isVisible()) await more.click();
    for (const title of ["Topic fxplain1", "Topic fxsub", "Renamed fxrename", "Topic fxunread"])
      await expect(chatRow(page, title)).toBeVisible();
    // The reply that landed while the guardian was away is still unread.
    await expect(
      chatRow(page, "Topic fxunread").getByRole("img", { name: "Done · new replies" }),
    ).toBeVisible();
    await expect(chatRow(page, "Topic fxarchive")).toHaveCount(0);
    await page.getByRole("button", { name: "List settings" }).click();
    await page.getByRole("menuitem", { name: "Archived" }).click();
    await page.keyboard.press("Escape");
    await expect(chatRow(page, "Topic fxarchive")).toBeVisible();
  });

  test("a seeded transcript reads in order", async ({ page }) => {
    await page.goto(`/chat/${manifest.dashboardChats.plain}`);
    const lines = [
      "Fixture plain E2E-REPLY fxplain1",
      "Reply to fxplain1",
      "And again E2E-REPLY fxplain2",
      "Reply to fxplain2",
    ];
    for (const line of lines) await expect(page.getByText(line)).toBeVisible();
    const ys = await Promise.all(
      lines.map(async (line) => (await page.getByText(line).boundingBox())!.y),
    );
    // The second turn's prompt and answer were written in the same second, so
    // their order rests on more than the timestamp.
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  test("a seeded chat takes a new turn after its old ones", async ({ page }) => {
    await page.goto(`/chat/${manifest.dashboardChats.plain}`);
    await expect(page.getByText("Reply to fxplain2")).toBeVisible();
    await send(page, "After the upgrade E2E-REPLY fxplain3");
    await expect(page.getByText("Reply to fxplain3")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Reply to fxplain3")).toBeVisible();
    const before = (await page.getByText("Reply to fxplain2").boundingBox())!.y;
    const after = (await page.getByText("Reply to fxplain3").boundingBox())!.y;
    expect(after).toBeGreaterThan(before);
  });

  test("a seeded subagent run still opens in the trace drawer", async ({ page }) => {
    await page.goto(`/chat/${manifest.dashboardChats.subagent}`);
    await expect(page.getByText("Parent done fxsub")).toBeVisible();
    await page
      .getByText(/1 app · 1 step/)
      .first()
      .click();
    await expect(page.getByText("E2E-CHILD fxsub")).toBeVisible();
  });

  test("search finds a seeded chat by its reply", async ({ page }) => {
    await page.goto("/chat");
    await page.getByRole("button", { name: "Search pages, apps, and chats" }).click();
    const search = page.getByRole("dialog");
    await search
      .getByRole("combobox")
      .or(search.getByRole("textbox"))
      .first()
      .fill("Reply to fxrename");
    const hit = search.getByRole("option").filter({ hasText: "Renamed fxrename" });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page.getByText("Fixture rename E2E-REPLY fxrename")).toBeVisible();
  });
});

const GUARDIAN_TG = { id: 5000001, first_name: "Gina", username: "gina_guardian" };
const SUPERGROUP: TelegramChat = { id: -1002003004005, type: "supergroup", title: "Fixture team" };
const { alpha, beta } = TELEGRAM_BOTS;

test.describe("platform chats", () => {
  test("the seeded WeChat chat shows its transcript and takes a new message", async ({ page }) => {
    await control.wechatSays("After the upgrade E2E-REPLY fxwx3");
    await expect
      .poll(async () => (await control.wechatMessages()).map((m) => m.text), { timeout: 60_000 })
      .toContain("Reply to fxwx3");
    await page.goto("/sessions/all");
    await page.getByRole("row").filter({ hasText: "wechat:e2e-guardian@im.wechat" }).click();
    const lines = ["Fixture wechat E2E-REPLY fxwx1", "Reply to fxwx2", "Reply to fxwx3"];
    for (const line of lines) await expect(page.getByText(line)).toBeVisible();
    const ys = await Promise.all(
      lines.map(async (line) => (await page.getByText(line).boundingBox())!.y),
    );
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  test("the seeded Telegram groups show their transcripts", async ({ page }) => {
    for (const [title, line] of [
      ["Fixture family", "Fixture basic ambient fxbasic3"],
      ["Fixture team", "Fixture super ambient fxsuper3"],
    ]) {
      await page.goto("/sessions/all");
      await page.getByRole("row").filter({ hasText: title }).first().click();
      await expect(page.getByText(line).first()).toBeVisible();
    }
  });

  test("a seeded Telegram supergroup takes a new message", async () => {
    await control.telegramSays({
      chat: SUPERGROUP,
      from: GUARDIAN_TG,
      text: `@${alpha.username} After the upgrade E2E-REPLY fxsuper5`,
      bots: [alpha.username, beta.username],
      mention: alpha.username,
    });
    await expect
      .poll(
        async () =>
          (await control.telegramMessages()).some(
            (m) => m.from === alpha.username && m.text === "Reply to fxsuper5",
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    const rows = await control.sql<{ n: number }>(
      `select count(*) as n from chat_messages m join chats c on c.id = m.chat_id
       where c.platform_chat_id = '${SUPERGROUP.id}' and m.text like '%fxsuper5%'`,
    );
    // The guardian's message, said once in the group, and alpha's reply.
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});
