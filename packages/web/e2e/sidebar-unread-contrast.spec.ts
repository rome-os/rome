import { expect, test } from "./fixtures.js";
import { BUILTIN_THEMES } from "../src/lib/themes";

test.use({ viewport: { width: 1280, height: 900 } });

test("unread numerals clear AA over their rendered tint in every theme", async ({ page }) => {
  await page.goto("/message");
  const badge = page.locator('[data-concierge-topic="mock-topic-travel"] [data-concierge-unread]');
  await expect(badge).toBeVisible({ timeout: 30_000 });
  await page.addStyleTag({ content: "* { transition: none !important; }" });

  for (const theme of BUILTIN_THEMES) {
    for (const dark of [false, true]) {
      await page.evaluate(
        ({ id, dark }) => {
          document.documentElement.dataset.theme = id;
          document.documentElement.classList.toggle("dark", dark);
        },
        { id: theme.id, dark },
      );

      for (const hovered of [false, true]) {
        if (hovered) await badge.hover();
        else await page.mouse.move(0, 0);

        const ratio = await badge.evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d")!;
          const ancestors: Element[] = [];
          for (let node: Element | null = element; node; node = node.parentElement) {
            ancestors.unshift(node);
          }
          // Paint the ancestor backgrounds before the translucent badge tint.
          // Canvas resolves color-mix/oklch and performs the sRGB compositing.
          for (const node of ancestors) {
            ctx.fillStyle = getComputedStyle(node).backgroundColor;
            ctx.fillRect(0, 0, 1, 1);
          }
          const background = ctx.getImageData(0, 0, 1, 1).data;
          ctx.fillStyle = getComputedStyle(element).color;
          ctx.fillRect(0, 0, 1, 1);
          const foreground = ctx.getImageData(0, 0, 1, 1).data;
          const luminance = (rgba: Uint8ClampedArray) => {
            const linear = Array.from(rgba)
              .slice(0, 3)
              .map((channel) => {
                const c = channel / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              });
            return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
          };
          const [light, dark] = [luminance(foreground), luminance(background)].sort(
            (a, b) => b - a,
          );
          return (light + 0.05) / (dark + 0.05);
        });

        expect(
          ratio,
          `${theme.id}/${dark ? "dark" : "light"}/${hovered ? "hover" : "idle"}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});
