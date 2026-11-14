import { expect, test } from "@playwright/test";

// A failed turn read back from its stored trace shows the guidance the live
// banner showed. It sits in the row's body under the commentary the turn had
// already said, never in the one-line header, so it pushes the row down
// instead of overlapping what is around it. The mock's third chat ends in such
// a turn.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
});

for (const width of [320, 390, 1440]) {
  test(`a failed turn's guidance takes its own space in the row at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/chat/mock-chat-3");
    const commentary = page.getByText("Fetching it from the vendor portal.").last();
    await expect(commentary).toBeVisible({ timeout: 30_000 });
    const guidance = page.getByRole("alert").filter({ hasText: "AI Tools" }).last();
    await expect(guidance).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const said = await commentary.boundingBox();
    const alert = await guidance.boundingBox();
    expect(said && alert).toBeTruthy();
    // Below what the turn said, not on top of it.
    expect(alert!.y).toBeGreaterThanOrEqual(said!.y + said!.height - 1);
    // Inside the transcript's column, with nothing scrolling sideways.
    const column = await guidance.evaluate((el) => {
      const row = el.closest("[data-chat-card-message], .group") ?? el.parentElement!;
      return row.getBoundingClientRect().right;
    });
    expect(alert!.x + alert!.width).toBeLessThanOrEqual(column + 1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}
