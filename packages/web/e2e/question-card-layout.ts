import { expect, type Locator } from "@playwright/test";

export async function expectQuestionCardContained(fieldset: Locator) {
  const violations = await fieldset.evaluate((el) => {
    const card = el.parentElement!;
    const bounds = card.getBoundingClientRect();
    const failures: string[] = [];
    for (const node of [
      card,
      ...card.querySelectorAll("fieldset, label, button, input, textarea"),
    ]) {
      const rect = node.getBoundingClientRect();
      const name = `${node.tagName}: ${node.textContent?.slice(0, 40)}`;
      if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
        failures.push(`${name} extends outside the card`);
      }
      // Inputs scroll their own value, but must not widen the form.
      if (node.tagName !== "INPUT" && node.scrollWidth > node.clientWidth + 1) {
        failures.push(`${name} overflows horizontally`);
      }
      if (node.tagName !== "BUTTON") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const text of range.getClientRects()) {
        if (
          text.left < rect.left - 1 ||
          text.right > rect.right + 1 ||
          text.top < rect.top - 1 ||
          text.bottom > rect.bottom + 1
        ) {
          failures.push(`${name} clips its label`);
        }
      }
    }
    return failures;
  });
  expect(violations).toEqual([]);
}
