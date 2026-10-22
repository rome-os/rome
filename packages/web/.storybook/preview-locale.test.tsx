// @rstest-environment jsdom
import { afterEach, expect, test } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n, { SUPPORTED_LANGUAGES } from "../src/i18n";
import { PairingRequestCard } from "../src/components/pairing/pairing-views";
import { storyLocale } from "./locale";
import { Locale } from "./preview";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
  localStorage.clear();
  document.documentElement.removeAttribute("dir");
});

test("locale updates existing components without remounting them", async () => {
  const user = userEvent.setup();
  const content = (
    <details>
      <summary>Request</summary>
      <PairingRequestCard
        name="Alex"
        accountId="123"
        channel="Telegram"
        createdAt="2026-09-10T10:00:00.000Z"
        expiresAt={Date.UTC(2026, 8, 10, 10, 10)}
        status="approved"
      />
    </details>
  );
  const view = render(<Locale locale="en">{content}</Locale>);
  await user.click(screen.getByText("Request"));
  expect(view.container.querySelector("details")?.open).toBe(true);
  view.rerender(<Locale locale="zh-CN">{content}</Locale>);
  await screen.findByText("已批准");
  expect(view.container.querySelector("details")?.open).toBe(true);
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(document.documentElement.dir).toBe("ltr");
  view.rerender(<Locale locale="en">{content}</Locale>);
  await screen.findByText("Approved");
  expect(view.container.querySelector("details")?.open).toBe(true);
});

test("the toolbar accepts every supported language and falls back for invalid globals", () => {
  for (const language of SUPPORTED_LANGUAGES) expect(storyLocale(language)).toBe(language);
  for (const value of [undefined, null, "invalid", 42]) expect(storyLocale(value)).toBe("en");
});
