// @rstest-environment jsdom
import { afterEach, expect, it } from "@rstest/core";
import { cleanup, render } from "@testing-library/react";
import i18n from "@/i18n";
import { ModelSwitchNotice } from "./ModelSwitchNotice";
import type { QuotaSwitchPart } from "@rome/api-types/chat";
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});
it.each([
  [undefined, "Claude quota ran out, switched to Codex", "Claude 额度已用完，已切换到 Codex"],
  ["quota", "Claude quota ran out, switched to Codex", "Claude 额度已用完，已切换到 Codex"],
  ["login", "Claude sign-in failed, switched to Codex", "Claude 登录失败，已切换到 Codex"],
  [
    "temporary",
    "Claude is temporarily unavailable, switched to Codex",
    "Claude 暂时无法使用，已切换到 Codex",
  ],
  [
    "model_limit",
    "Switched to Opus 5.5; Sonnet 5.5 is unavailable for now",
    "已换成 Opus 5.5，Sonnet 5.5 暂时用不了",
  ],
] as const)("renders %s in both languages", async (reason, en, zh) => {
  for (const [locale, text] of [
    ["en", en],
    ["zh-CN", zh],
  ]) {
    await i18n.changeLanguage(locale);
    const quota: QuotaSwitchPart = {
      type: "quota_switch",
      from: "anthropic",
      to: reason === "model_limit" ? "anthropic" : "openai",
      fromModel: "claude-sonnet-5-5",
      model: reason === "model_limit" ? "claude-opus-5-5[1m]" : "gpt-6-luna",
      ...(reason ? { reason } : {}),
    };
    const view = render(<ModelSwitchNotice model={quota.model} quota={quota} />);
    expect(view.getByRole("note").textContent).toBe(text);
    view.unmount();
  }
});

it("names models for an ambiguous quota fallback on the same provider", () => {
  const view = render(
    <ModelSwitchNotice
      model="claude-opus-5-5[1m]"
      quota={{
        type: "quota_switch",
        from: "anthropic",
        to: "anthropic",
        reason: "quota",
        fromModel: "claude-sonnet-5-5",
        model: "claude-opus-5-5[1m]",
      }}
    />,
  );
  expect(view.getByRole("note").textContent).toBe(
    "Switched to Opus 5.5; Sonnet 5.5 is unavailable for now",
  );
});

it("names the provider when the chat moved to another provider", () => {
  const view = render(<ModelSwitchNotice model="claude-opus-5-5[1m]" fromModel="gpt-6-luna" />);
  expect(view.getByRole("note").textContent).toBe("Switched to Claude");
  view.rerender(<ModelSwitchNotice model="gpt-6-luna" fromModel="claude-opus-5-5" />);
  expect(view.getByRole("note").textContent).toBe("Switched to ChatGPT");
});

it("names the model when the chat stayed on one provider", () => {
  const view = render(<ModelSwitchNotice model="claude-opus-5-5" fromModel="claude-sonnet-5-5" />);
  expect(view.getByRole("note").textContent).toBe("Switched to Opus 5.5");
});
