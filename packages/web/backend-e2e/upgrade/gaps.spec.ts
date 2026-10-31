import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { control, type TelegramChat } from "../control";
import { expect, test } from "../fixtures";
import {
  DM_GUARDIAN,
  GUARDIAN_TG,
  alpha,
  api,
  beta,
  connectChannels,
  telegramReplied,
  wechatReplied,
} from "./world";

// Captures what each known gap between one Rome and the next looks like, for
// a before-and-after comparison: run it once on each Rome with the same
// E2E_CAPTURE_DIR and a different E2E_CAPTURE_LABEL. With E2E_FIXTURE set it
// captures the upgraded fixture; without, it drives fresh chats.

const dir = process.env.E2E_CAPTURE_DIR;
const label = process.env.E2E_CAPTURE_LABEL ?? "capture";
test.skip(!dir, "Set E2E_CAPTURE_DIR to capture the gaps");
test.describe.configure({ mode: "serial" });

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(dir!, { recursive: true });
  await page.screenshot({ path: join(dir!, `${name}.${label}.png`), fullPage: true });
}

function note(name: string, body: string): void {
  mkdirSync(dir!, { recursive: true });
  writeFileSync(join(dir!, `${name}.${label}.txt`), body);
}

async function sessionOf(channelOfAccount: string, threadId: number | string): Promise<string> {
  const [row] = await control.sql<{ id: string }>(
    `select s.id from rome_sessions s join channels c on c.id = s.source_channel
     where c.platform_account_id = '${channelOfAccount}' and s.source_thread_id = '${threadId}'`,
  );
  if (!row) throw new Error(`No session for ${channelOfAccount} in ${threadId}`);
  return row.id;
}

test.describe("on the upgraded fixture", () => {
  test.skip(!process.env.E2E_FIXTURE, "Set E2E_FIXTURE");

  test("a turn whose prompt and answer share a second", async ({ page }) => {
    const { dashboardChats } = JSON.parse(
      readFileSync(join(process.env.E2E_FIXTURE!, "manifest.json"), "utf8"),
    ) as { dashboardChats: { plain: string } };
    await page.goto(`/chat/${dashboardChats.plain}`);
    await expect(page.getByText("Reply to fxplain2")).toBeVisible();
    await shot(page, "order");
  });
});

test.describe("on fresh chats", () => {
  test.skip(!!process.env.E2E_FIXTURE, "Runs without E2E_FIXTURE");

  test("connects WeChat and two Telegram bots", async ({ page }) => {
    await connectChannels(page);
  });

  test("a bot that joins a group later", async ({ page }) => {
    const group: TelegramChat = { id: -4009990001, type: "group", title: "Late join group" };
    await control.telegramSays({
      chat: group,
      from: GUARDIAN_TG,
      text: `@${alpha.username} Before beta joined E2E-REPLY gapl1`,
      bots: [alpha.username],
      mention: alpha.username,
    });
    await telegramReplied(alpha.username, group.id, "Reply to gapl1");
    await control.telegramSays({
      chat: group,
      from: GUARDIAN_TG,
      text: `@${beta.username} After beta joined E2E-REPLY gapl2`,
      bots: [alpha.username, beta.username],
      mention: beta.username,
    });
    await telegramReplied(beta.username, group.id, "Reply to gapl2");
    const seat = await sessionOf(beta.id, group.id);
    await page.goto(`/sessions/${seat}`);
    await expect(page.getByText("After beta joined E2E-REPLY gapl2").first()).toBeVisible();
    await page.waitForTimeout(1_000);
    await shot(page, "late-seat");
    const calls = (await control.model()).calls.filter(
      (c) => c.directive === "REPLY gapl2",
    ) as Array<{
      prompt?: string;
    }>;
    const call = calls[0];
    note(
      "late-seat",
      [
        `Beta's model was called ${calls.length} time(s) for the mention.`,
        `What the group said before beta joined reached beta: ${call?.prompt?.includes("Before beta joined") ? "yes" : "no"}.`,
        "",
        "What beta read as the guardian's message:",
        "",
        ...calls.map((c, i) => `--- call ${i + 1} ---\n${c.prompt ?? ""}`),
      ].join("\n"),
    );
  });

  test("a quote of the first message of a long reply", async ({ page }) => {
    // A reply goes out as one message per block only while it streams, which
    // is an experimental setting.
    await api(page.request, "PUT", "/api/settings", { enableReplyStreaming: true });
    await control.telegramSays({
      chat: DM_GUARDIAN,
      from: GUARDIAN_TG,
      text: "Write a lot E2E-LONG gapq",
      bots: [alpha.username],
    });
    let first = 0;
    await expect
      .poll(
        async () => {
          const parts = (await control.telegramMessages()).filter(
            (m) => m.from === alpha.username && m.chatId === DM_GUARDIAN.id,
          );
          first = parts.find((m) => m.text.startsWith("Opening part of gapq"))?.messageId ?? 0;
          return parts.some((m) => m.text.includes("Closing part of gapq")) ? first : 0;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    const parts = (await control.telegramMessages()).filter(
      (m) => m.from === alpha.username && m.chatId === DM_GUARDIAN.id && m.messageId >= first,
    );
    await control.telegramSays({
      chat: DM_GUARDIAN,
      from: GUARDIAN_TG,
      text: "About your first message E2E-REPLY gapq2",
      bots: [alpha.username],
      replyTo: { bot: alpha.username, messageId: first },
    });
    await telegramReplied(alpha.username, DM_GUARDIAN.id, "Reply to gapq2");
    const call = (await control.model()).calls.findLast((c) => c.directive === "REPLY gapq2") as
      | { prompt?: string }
      | undefined;
    note(
      "quote",
      [
        `The reply went out as ${parts.length} Telegram messages; the guardian quoted the first (id ${first}).`,
        `The quoted text reached the agent: ${call?.prompt?.includes("Opening part of gapq") ? "yes" : "no"}.`,
        "",
        "What the agent read as the guardian's message:",
        "",
        call?.prompt ?? "(no model call found)",
      ].join("\n"),
    );
    await page.goto(`/sessions/${await sessionOf(alpha.id, DM_GUARDIAN.id)}`);
    await expect(page.getByText("About your first message E2E-REPLY gapq2").first()).toBeVisible();
    await shot(page, "quote");
  });

  test("a wakeup the agent set in a channel chat", async ({ page }) => {
    test.setTimeout(240_000);
    await control.wechatSays("Check back on this later E2E-DEFER gapd");
    await wechatReplied("Deferred gapd");
    // The one-off routine fires a minute later and resumes the chat.
    await expect
      .poll(async () => (await control.wechatMessages()).map((m) => m.text), {
        timeout: 180_000,
        intervals: [5_000],
      })
      .toContain("Reply to gapdw");
    await page.goto("/sessions/all");
    await page.getByRole("row").filter({ hasText: "wechat:e2e-guardian@im.wechat" }).click();
    await expect(page.getByText("Reply to gapdw").first()).toBeVisible();
    await page.waitForTimeout(1_000);
    await shot(page, "wakeup");
  });
});
