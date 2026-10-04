import { expect, test } from "@playwright/test";

for (const { width, height, hasTouch } of [
  { width: 320, height: 800, hasTouch: true },
  { width: 390, height: 844, hasTouch: true },
  { width: 844, height: 390, hasTouch: true },
  { width: 1024, height: 768, hasTouch: true },
  { width: 1280, height: 900, hasTouch: false },
]) {
  test.describe(`${width}px ${hasTouch ? "touch" : "pointer"} controls`, () => {
    test.use({ viewport: { width, height }, hasTouch });

    test("keeps menu targets reachable and scopes large titles to page headings", async ({
      page,
    }) => {
      await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
      await page.goto("/activity");
      const heading = page.getByRole("heading", { name: "Activity", exact: true });
      await expect(heading).toBeVisible();
      await expect(heading).toHaveCSS("font-size", width < 768 ? "28px" : "18px");
      await expect(page.locator("main .text-title:not(h1)").first()).toHaveCSS("font-size", "18px");

      const filters = page.getByRole("radiogroup", { name: "Activity status" });
      const pending = filters.getByRole("radio", { name: "Pending", exact: true });
      if (hasTouch) {
        for (const radio of await filters.getByRole("radio").all()) {
          expect((await radio.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        expect(
          (await page.getByRole("button", { name: "Refresh", exact: true }).boundingBox())!.height,
        ).toBeGreaterThanOrEqual(44);
      }
      await pending.click();
      await expect(pending).toHaveAttribute("aria-checked", "true");
      await pending.focus();
      await page.keyboard.down("ArrowRight");
      await expect(filters.getByRole("radio", { name: "Running", exact: true })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.keyboard.up("ArrowRight");

      if (width < 768)
        await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Account", exact: true }).click();
      const settings = page.getByRole("menuitem", { name: "Settings", exact: true });
      await expect(settings).toBeVisible();
      const menuHeight = (await settings.boundingBox())!.height;
      if (hasTouch) expect(menuHeight).toBeGreaterThanOrEqual(44);
      else expect(menuHeight).toBeLessThan(44);
    });

    test("keeps calendar days and explicit small field roles usable", async ({ page }) => {
      await page.goto("/dev/gallery");
      const calendar = page.locator('[data-slot="calendar"]').first();
      await expect(calendar).toBeVisible();
      const day = calendar.locator("button[data-day]").first();
      const dayBox = (await day.boundingBox())!;
      if (hasTouch) {
        expect(dayBox.width).toBeGreaterThanOrEqual(44);
        expect(dayBox.height).toBeGreaterThanOrEqual(44);
        expect((await calendar.boundingBox())!.width).toBeLessThanOrEqual(width);
      } else {
        expect(dayBox.width).toBe(28);
      }
      const field = page.locator('input[data-slot="input"]').first();
      await field.evaluate((element) => element.classList.add("text-aux"));
      if (hasTouch) await expect(field).toHaveCSS("font-size", "17px");
      const switches = page.locator('[data-slot="switch"]');
      if (hasTouch) {
        for (const control of await switches.all()) {
          const box = (await control.boundingBox())!;
          expect(box.width).toBe(48);
          expect(box.height).toBe(28);
        }
      }
    });
  });
}

for (const hasTouch of [false, true]) {
  test.describe(`explicit scale with ${hasTouch ? "touch" : "mouse"}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch });
    test("resizes the whole gallery and its portals through the header selector", async ({
      page,
    }) => {
      await page.goto("/dev/gallery#platform-scale");
      const choices = page.getByRole("radiogroup", { name: "Preview scale" });
      const preview = page.locator("[data-scale-preview]");
      const button = preview.getByRole("button", { name: "Scale button", exact: true });
      await expect(button).toHaveCSS("height", hasTouch ? "44px" : "24px");
      for (const [scale, height] of [
        ["Medium", "24px"],
        ["Large", "44px"],
      ] as const) {
        await choices.getByRole("radio", { name: scale, exact: true }).click();
        await expect(button).toHaveCSS("height", height);
        const field = preview.getByRole("textbox", { name: "Scale field" });
        await expect(field).toHaveCSS("height", scale === "Large" ? "44px" : "32px");
        await expect(field).toHaveCSS("padding-left", scale === "Large" ? "16px" : "12px");
        await expect(page.locator("html")).toHaveAttribute("data-ui-scale", scale.toLowerCase());
        const calendarDay = page.locator('[data-slot="calendar"] button[data-day]').first();
        await expect(calendarDay).toHaveCSS("width", scale === "Large" ? "44px" : "28px");
        const switchControl = page.locator('[data-slot="switch"]').first();
        await expect(switchControl).toHaveCSS("width", scale === "Large" ? "48px" : "32px");
        await preview.getByRole("button", { name: "Scale menu", exact: true }).click();
        const option = page.getByRole("menuitem", { name: "Scale option", exact: true });
        await expect(option).toBeVisible();
        const size = (await option.boundingBox())!.height;
        if (scale === "Large") expect(size).toBeGreaterThanOrEqual(44);
        else expect(size).toBeLessThan(44);
        await page.keyboard.press("Escape");
      }
      await choices.getByRole("radio", { name: "Auto", exact: true }).click();
      await expect(button).toHaveCSS("height", hasTouch ? "44px" : "24px");
      await choices.getByRole("radio", { name: "Large", exact: true }).click();
      await page.evaluate(() => {
        window.history.pushState({}, "", "/activity");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-ui-scale",
        hasTouch ? "large" : "medium",
      );
    });
  });
}
