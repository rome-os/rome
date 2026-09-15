// @rstest-environment jsdom
import { afterEach, expect, test, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../src/i18n";
import { PairingCodeSection } from "../src/components/pairing/pairing-views";
import { Locale } from "./preview";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
  localStorage.clear();
  document.documentElement.removeAttribute("dir");
});

test("locale updates existing components without resetting an expanded code section", async () => {
  const user = userEvent.setup();
  const onCopy = rs.fn();
  const content = (
    <PairingCodeSection
      channel="Telegram"
      accountName="Alex"
      state={{ kind: "ready", code: "RP-12AB34CD", copied: false }}
      onCopy={onCopy}
      onRetry={() => undefined}
    />
  );
  const view = render(<Locale locale="en">{content}</Locale>);
  await user.click(screen.getByText("Pair with a verification code"));
  expect(view.container.querySelector("details")?.open).toBe(true);
  view.rerender(<Locale locale="zh-CN">{content}</Locale>);
  const copy = await screen.findByRole("button", { name: "复制" });
  expect(view.container.querySelector("details")?.open).toBe(true);
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(document.documentElement.dir).toBe("ltr");
  await user.click(copy);
  expect(onCopy).toHaveBeenCalledTimes(1);
  view.rerender(<Locale locale="en">{content}</Locale>);
  await screen.findByRole("button", { name: "Copy" });
  expect(view.container.querySelector("details")?.open).toBe(true);
});
