import { token } from "./control";
import { expect, startChat, test } from "./fixtures";

// The Sessions page reads the same conversations through its own routes, and
// a subagent run is a session of its own under the chat's turn.

test("a chat's session shows its transcript on the Sessions page", async ({ page }) => {
  const t = token("sess");
  await startChat(page, `Track E2E-REPLY ${t}`);
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();

  await page.goto("/sessions/all");
  const row = page.getByRole("row").filter({ hasText: `Topic ${t}` });
  await expect(row).toContainText("Chat");
  await row.click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
  await expect(page.getByText(`Track E2E-REPLY ${t}`)).toBeVisible();
  await expect(page.getByText(`Reply to ${t}`)).toBeVisible();
});

test("a subagent turn shows in the chat, its trace, and Sessions", async ({ page }) => {
  const t = token("sub");
  await startChat(page, `Delegate E2E-SUBAGENT ${t}`);
  await expect(page.getByText(`Parent done ${t}`)).toBeVisible();

  // The reply's run summary opens the trace drawer, which lists the subagent
  // run with the prompt it was given.
  await page
    .getByText(/1 app · 1 step/)
    .first()
    .click();
  const trace = page.getByText(`E2E-CHILD ${t}`);
  await expect(trace).toBeVisible();
  await expect(page.getByText("completed").first()).toBeVisible();

  // After a reload the trace still comes from storage.
  await page.reload();
  await expect(page.getByText(`Parent done ${t}`)).toBeVisible();
  await page
    .getByText(/1 app · 1 step/)
    .first()
    .click();
  await expect(page.getByText(`E2E-CHILD ${t}`)).toBeVisible();

  await page.goto("/sessions/all");
  const parent = page.getByRole("row").filter({ hasText: `Topic ${t}` });
  await expect(parent).toBeVisible();
  await parent.click();
  await expect(page.getByText(`Parent done ${t}`)).toBeVisible();

  // The subagent's own session holds its prompt and answer. Sessions sorts by
  // last activity, so the newest Subagent row is this test's.
  await page.goto("/sessions/all");
  await page.getByRole("row").filter({ hasText: "Subagent" }).first().click();
  await expect(page.getByText(`E2E-CHILD ${t}`)).toBeVisible();
  await expect(page.getByText(`Child says ${t}`)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Parent" }).or(page.getByRole("link", { name: "Parent" })),
  ).toBeVisible();
});
