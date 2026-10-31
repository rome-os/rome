import { token } from "./control";
import { chatRow, expect, send, startChat, test } from "./fixtures";

// A dashboard chat, from the first message to a transcript read back from
// storage after a reload.

test("a new chat shows the reply, gets a title, and is listed", async ({ page }) => {
  const t = token("first");
  await startChat(page, `Hello E2E-REPLY ${t}`);

  await expect(page.getByText(`Hello E2E-REPLY ${t}`)).toBeVisible();
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();
  // Rome names the chat from the first message through the model.
  await expect(chatRow(page, `Topic ${t}`)).toBeVisible();
  await page.reload();
  await expect(chatRow(page, `Topic ${t}`)).toBeVisible();
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();
});

test("a chat's transcript survives a reload, in order", async ({ page }) => {
  const t = token("order");
  await startChat(page, `First E2E-REPLY ${t}a`);
  await expect(page.getByText(`Reply to ${t}a`)).toBeVisible();
  await send(page, `Second E2E-REPLY ${t}b`);
  await expect(page.getByText(`Reply to ${t}b`)).toBeVisible();

  await page.reload();
  const lines = [
    `First E2E-REPLY ${t}a`,
    `Reply to ${t}a`,
    `Second E2E-REPLY ${t}b`,
    `Reply to ${t}b`,
  ];
  for (const line of lines) await expect(page.getByText(line, { exact: true })).toBeVisible();
  const tops = await Promise.all(
    lines.map(async (line) => (await page.getByText(line, { exact: true }).boundingBox())!.y),
  );
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
});

test("opening a chat from the list shows its transcript", async ({ page }) => {
  const t = token("reopen");
  await startChat(page, `Remember E2E-REPLY ${t}`);
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();
  await expect(chatRow(page, `Topic ${t}`)).toBeVisible();

  await page.goto("/chat");
  await expect(page.getByText(`Reply to ${t}`)).toHaveCount(0);
  await chatRow(page, `Topic ${t}`).getByRole("link").click();
  await expect(page.getByText(`Remember E2E-REPLY ${t}`)).toBeVisible();
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();
});

test("a reply that lands while the guardian is elsewhere marks the chat", async ({ page }) => {
  const t = token("unread");
  await startChat(page, `Take your time E2E-SLOW ${t}`);
  // Leave before the reply lands (the fake model holds it for 4 s).
  await page.getByRole("link", { name: "New chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);

  const row = chatRow(page, `Topic ${t}`);
  await expect(row.getByRole("img", { name: "Done · new replies" })).toBeVisible();
  await row.getByRole("link").click();
  await expect(page.getByText(`Slow reply to ${t}`)).toBeVisible();
  await page.goto("/chat");
  await expect(row.getByRole("img", { name: "Done · new replies" })).toHaveCount(0);
});

test("search finds a chat by what was said in it", async ({ page }) => {
  const t = token("find");
  await startChat(page, `Needle E2E-REPLY ${t}`);
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();

  await page.goto("/chat");
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog");
  await search.getByRole("combobox").or(search.getByRole("textbox")).first().fill(`Reply to ${t}`);
  const hit = search.getByRole("option").filter({ hasText: `Topic ${t}` });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.getByText(`Needle E2E-REPLY ${t}`)).toBeVisible();
});
