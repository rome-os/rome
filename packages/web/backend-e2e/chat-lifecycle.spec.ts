import { token } from "./control";
import { chatRow, expect, openChatActions, startChat, test } from "./fixtures";

// Rename, archive and delete from the chat list, each checked after a reload
// so the assertion reads storage, not the page's own state.

async function chatWithReply(page: import("@playwright/test").Page, t: string) {
  const id = await startChat(page, `Lifecycle E2E-REPLY ${t}`);
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();
  await expect(chatRow(page, `Topic ${t}`)).toBeVisible();
  return id;
}

test("renaming a chat renames it everywhere", async ({ page }) => {
  const t = token("rename");
  await chatWithReply(page, t);

  await openChatActions(page, `Topic ${t}`);
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.getByRole("textbox", { name: "Chat name" });
  await input.fill(`Renamed ${t}`);
  await input.press("Enter");

  await expect(chatRow(page, `Renamed ${t}`)).toBeVisible();
  await page.reload();
  await expect(chatRow(page, `Renamed ${t}`)).toBeVisible();
  await expect(chatRow(page, `Topic ${t}`)).toHaveCount(0);
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();

  await page.goto("/sessions/all");
  await expect(page.getByRole("row").filter({ hasText: `Renamed ${t}` })).toBeVisible();
});

test("archiving a chat moves it out of the active list and back", async ({ page }) => {
  const t = token("archive");
  await chatWithReply(page, t);

  await openChatActions(page, `Topic ${t}`);
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.goto("/chat");
  await expect(chatRow(page, `Topic ${t}`)).toHaveCount(0);

  await page.getByRole("button", { name: "List settings" }).click();
  await page.getByRole("menuitem", { name: "Archived" }).click();
  await page.keyboard.press("Escape");
  await expect(chatRow(page, `Topic ${t}`)).toBeVisible();

  await openChatActions(page, `Topic ${t}`);
  await page.getByRole("menuitem", { name: "Unarchive chat" }).click();
  await page.getByRole("button", { name: "List settings" }).click();
  await page.getByRole("menuitem", { name: "Active" }).click();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(chatRow(page, `Topic ${t}`)).toBeVisible();
});

test("deleting a chat removes it and its transcript", async ({ page }) => {
  const t = token("delete");
  const id = await chatWithReply(page, t);

  await openChatActions(page, `Topic ${t}`);
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();

  await expect(chatRow(page, `Topic ${t}`)).toHaveCount(0);
  await page.goto("/chat");
  await expect(chatRow(page, `Topic ${t}`)).toHaveCount(0);

  expect((await page.request.get(`/api/chat/sessions/${id}`)).status()).toBe(404);
  await page.goto("/sessions/all");
  await expect(page.getByRole("row").first()).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `Topic ${t}` })).toHaveCount(0);
});
