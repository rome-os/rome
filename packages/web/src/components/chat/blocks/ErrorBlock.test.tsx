// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import i18n from "@/i18n";
import { ErrorBlock } from "./ErrorBlock";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("ErrorBlock", () => {
  it("guides a logged-out Codex user to AI Tools", () => {
    render(
      <MemoryRouter>
        <ErrorBlock
          error="Selected model provider is unavailable: Codex"
          code="model_provider_unavailable"
          provider="openai"
          reason="not_logged_in"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Codex 尚未登录")).toBeTruthy();
    expect(screen.queryByText("Selected model provider is unavailable: Codex")).toBeNull();
    expect(screen.getByRole("link", { name: /前往登录/ }).getAttribute("href")).toBe(
      "/settings/ai-tools",
    );
  });

  it("guides a user with revoked Claude auth to reconnect in AI Tools", () => {
    render(
      <MemoryRouter>
        <ErrorBlock
          error="OAuth token revoked · Please run /login"
          code="auth_revoked"
          provider="anthropic"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("重新连接 Claude")).toBeTruthy();
    expect(screen.queryByText("OAuth token revoked · Please run /login")).toBeNull();
    expect(screen.getByRole("link", { name: /重新连接/ }).getAttribute("href")).toBe(
      "/settings/ai-tools",
    );
  });

  it("guides a user to switch accounts or wait when every connected provider is exhausted", () => {
    render(
      <MemoryRouter>
        <ErrorBlock
          error="All connected model providers have reached their usage limits"
          code="no_model_provider_available"
          reason="quota_exhausted"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("所有已连接的 AI Provider 使用额度均已耗尽")).toBeTruthy();
    expect(screen.getByText("请登录其他账号，或等待使用额度重置。")).toBeTruthy();
    expect(screen.getByRole("link", { name: /打开 AI Tools/ }).getAttribute("href")).toBe(
      "/settings/ai-tools",
    );
  });

  it("keeps unknown errors as plain text", () => {
    render(
      <MemoryRouter>
        <ErrorBlock error="Something else failed" />
      </MemoryRouter>,
    );

    expect(screen.getByText("Something else failed")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
