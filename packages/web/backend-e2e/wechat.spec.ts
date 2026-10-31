import { control, token, WECHAT_GUARDIAN } from "./control";
import { expect, test } from "./fixtures";

// A platform-bound chat. WeChat is connected through the real Settings flow
// (the fake iLink confirms the QR at once), and messages arrive through the
// adapter's real long poll.

test.describe.configure({ mode: "serial" });

test("WeChat connects from Settings", async ({ page }) => {
  await page.goto("/settings/connections/wechat");
  const connect = page.getByRole("button", { name: "Connect" });
  const connected = page.getByText("e2e-bot@im.bot");
  await expect(connect.or(connected)).toBeVisible();
  if (await connect.isVisible()) await connect.click();
  await expect(connected).toBeVisible();
  await expect(page.getByText("Your WeChat account is linked as guardian.")).toBeVisible();
});

async function romeReplied(text: string): Promise<void> {
  await expect
    .poll(async () => (await control.wechatMessages()).map((m) => `${m.to}: ${m.text}`), {
      timeout: 60_000,
    })
    .toContain(`${WECHAT_GUARDIAN}: ${text}`);
}

test("a WeChat message is answered on WeChat and shown in Sessions", async ({ page }) => {
  const t = token("wx");
  await control.wechatSays(`From my phone E2E-REPLY ${t}`);
  await romeReplied(`Reply to ${t}`);

  await page.goto("/sessions/all");
  const row = page.getByRole("row").filter({ hasText: `wechat:${WECHAT_GUARDIAN}` });
  await expect(row).toContainText("Channel");
  await row.click();
  await expect(page.getByText(`From my phone E2E-REPLY ${t}`)).toBeVisible();
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();

  // A later message lands in the same chat, after the earlier lines.
  const t2 = token("wx");
  await control.wechatSays(`Again E2E-REPLY ${t2}`);
  await romeReplied(`Reply to ${t2}`);
  await page.reload();
  await expect(page.getByText(`From my phone E2E-REPLY ${t}`)).toBeVisible();
  const first = (await page.getByText(`Reply to ${t}`).boundingBox())!.y;
  const second = (await page.getByText(`Reply to ${t2}`).boundingBox())!.y;
  expect(second).toBeGreaterThan(first);
});
