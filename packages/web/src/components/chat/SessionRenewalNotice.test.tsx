// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { SessionRenewalNotice } from "./SessionRenewalNotice";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("SessionRenewalNotice", () => {
  it("says the context was tidied up and why, as plain text that opens nothing and reads nothing", () => {
    const fetch = rs.fn();
    rs.stubGlobal("fetch", fetch);
    render(<SessionRenewalNotice reason="setup" />);
    expect(screen.getByRole("note").textContent).toBe("Context tidied up · setup updated");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/summary/i)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a reason this build does not know as it came", () => {
    render(<SessionRenewalNotice reason="moon_phase" />);
    expect(screen.getByRole("note").textContent).toBe("Context tidied up · moon_phase");
  });

  it("says it in Chinese too", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<SessionRenewalNotice reason="setup" />);
    expect(screen.getByRole("note").textContent).toBe("已整理上下文 · 设定已更新");
    await i18n.changeLanguage("en");
  });
});
