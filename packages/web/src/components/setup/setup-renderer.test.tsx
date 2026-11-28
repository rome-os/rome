// @rstest-environment jsdom
//
// Standard renderers plus the optional custom presenting component.
// Each state kind renders from its server-authored payload alone; a custom
// component overrides rendering only for the presenting state.
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SetupRenderer, type SetupRenderProps } from "@/components/setup/setup-renderer";
import i18n from "@/i18n";
import type { SetupState } from "@/lib/setup-api";

afterEach(async () => {
  cleanup();
  delete window.rome;
  if (i18n.language !== "en") {
    await i18n.changeLanguage("en");
  }
});

/** What `isElectronShell` reads: the desktop preload's bridge, absent in a browser. */
function asDesktopApp() {
  window.rome = {};
}

function renderState(state: SetupState, over: Partial<SetupRenderProps> = {}) {
  const props: SetupRenderProps = {
    state,
    busy: false,
    error: null,
    onSubmit: rs.fn(),
    onCancel: rs.fn(),
    onRetry: rs.fn(),
    ...over,
  };
  // Both call sites live inside the dashboard's router, and an in-app setup
  // link renders as a <Link>, which needs one.
  render(
    <MemoryRouter>
      <SetupRenderer {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("SetupRenderer standard renderers", () => {
  it("awaiting-redirect hands the sign-in to the system browser in the desktop app", () => {
    asDesktopApp();
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    renderState({ status: "awaiting-redirect", url: "https://slack.test/oauth/v2/authorize" });
    const link = screen.getByTestId("setup-redirect").querySelector("a") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(open).toHaveBeenCalledWith("https://slack.test/oauth/v2/authorize");
    expect(event.defaultPrevented).toBe(true);
    open.mockRestore();
  });

  it("awaiting-redirect navigates the same window in a browser", () => {
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    renderState({ status: "awaiting-redirect", url: "https://slack.test/oauth/v2/authorize" });
    const link = screen.getByTestId("setup-redirect").querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://slack.test/oauth/v2/authorize");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("awaiting-input renders the form and submits typed answers", () => {
    const onSubmit = rs.fn();
    renderState(
      {
        status: "awaiting-input",
        form: { fields: [{ name: "token", label: "Bot token", secret: true }] },
      },
      { onSubmit },
    );
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ token: "abc" });
  });

  it("awaiting-input submits a choice picked from an options field", async () => {
    const onSubmit = rs.fn();
    const user = userEvent.setup();
    renderState(
      {
        status: "awaiting-input",
        form: { fields: [{ name: "region", label: "Region", options: ["us", "eu"] }] },
      },
      { onSubmit },
    );
    await user.click(screen.getByLabelText("Region"));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", { name: "eu" }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ region: "eu" });
  });

  it("awaiting-input renders the form's setup guide — numbered steps and links", () => {
    renderState({
      status: "awaiting-input",
      form: {
        instructions: "Create a Telegram bot with @BotFather, then paste its token below.",
        steps: [{ text: "Open Telegram and chat with @BotFather." }, { text: "Send /newbot." }],
        links: [{ label: "Open @BotFather", url: "https://t.me/BotFather" }],
        fields: [{ name: "token", label: "Bot token", secret: true }],
      },
    });
    expect(screen.getByText("Open Telegram and chat with @BotFather.")).toBeTruthy();
    expect(screen.getByText("Send /newbot.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open @BotFather" });
    expect(link.getAttribute("href")).toBe("https://t.me/BotFather");
  });

  it("awaiting-input renders a trailing note below the fields", () => {
    renderState({
      status: "awaiting-input",
      form: {
        fields: [{ name: "token", label: "Bot token", secret: true }],
        note: 'Common issue — "View Channels" permission.',
      },
    });
    expect(screen.getByText('Common issue — "View Channels" permission.')).toBeTruthy();
  });

  it("awaiting-input surfaces a re-prompt validation error", () => {
    renderState({
      status: "awaiting-input",
      form: { fields: [{ name: "token", label: "Bot token", secret: true }] },
      error: "That token was rejected.",
    });
    expect(screen.getByText("That token was rejected.")).toBeTruthy();
  });

  it("presenting renders the view and offers cancel", () => {
    const onCancel = rs.fn();
    renderState(
      { status: "presenting", view: { title: "Link your account", body: ["Message the bot"] } },
      { onCancel },
    );
    expect(screen.getByText("Link your account")).toBeTruthy();
    expect(screen.getByText("Message the bot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("presenting renders a QR payload as an image (WhatsApp QR grant)", () => {
    renderState({
      status: "presenting",
      view: {
        title: "Scan with WhatsApp",
        qr: "data:image/png;base64,abc",
        links: [{ label: "Open QR link", url: "https://wa.me/qr/x" }],
      },
    });
    const img = screen.getByAltText("Scan with WhatsApp") as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,abc");
    expect(screen.getByRole("link", { name: "Open QR link" })).toBeTruthy();
  });

  it("done renders the summary view", () => {
    renderState({ status: "done", grant: { summary: { title: "Discord connected" } } });
    expect(screen.getByText("Discord connected")).toBeTruthy();
  });

  it("failed renders the reason and a retry", () => {
    const onRetry = rs.fn();
    renderState({ status: "failed", reason: "Ledger write failed." }, { onRetry });
    expect(screen.getByText("Ledger write failed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("cancelled offers a retry", () => {
    renderState({ status: "cancelled" });
    expect(screen.getByTestId("setup-cancelled")).toBeTruthy();
  });
});

describe("SetupRenderer custom presenting component", () => {
  it("uses the custom component for a presenting state, else the standard renderer", () => {
    const Custom = (_props: SetupRenderProps) => <div>custom-presenting</div>;
    const props = {
      busy: false,
      error: null,
      onSubmit: rs.fn(),
      onCancel: rs.fn(),
      onRetry: rs.fn(),
      renderPresenting: Custom,
    };
    const { rerender } = render(
      <SetupRenderer {...props} state={{ status: "presenting", view: { title: "std" } }} />,
    );
    expect(screen.getByText("custom-presenting")).toBeTruthy();
    expect(screen.queryByText("std")).toBeNull();

    rerender(<SetupRenderer {...props} state={{ status: "cancelled" }} />);
    expect(screen.queryByText("custom-presenting")).toBeNull();
    expect(screen.getByTestId("setup-cancelled")).toBeTruthy();
  });
});

describe("setup view links", () => {
  const view = {
    title: "Sign in to LinkedIn in Rome's browser",
    links: [
      { label: "Open Rome's browser", url: "/desktop" },
      { label: "Open @BotFather", url: "https://t.me/BotFather" },
    ],
  };

  // Safari holds no Rome session, so a link home arrives at a sign-in wall.
  it("routes an in-app link inside the Mac app instead of opening a tab", () => {
    asDesktopApp();
    renderState({ status: "presenting", view });

    const link = screen.getByRole("link", { name: "Open Rome's browser" });
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("href")).toBe("/desktop");
  });

  it("still hands a remote link to the browser inside the Mac app", () => {
    asDesktopApp();
    renderState({ status: "presenting", view });

    const link = screen.getByRole("link", { name: "Open @BotFather" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toBe("https://t.me/BotFather");
  });

  // A browser has tabs, and the panel stays readable in the one behind.
  it("leaves both kinds opening a new tab in a browser", () => {
    renderState({ status: "presenting", view });

    for (const name of ["Open Rome's browser", "Open @BotFather"]) {
      expect(screen.getByRole("link", { name }).getAttribute("target")).toBe("_blank");
    }
  });
});

describe("setup form option labels and i18n", () => {
  it("renders labeled select options and submits the underlying value", async () => {
    const onSubmit = rs.fn();
    const user = userEvent.setup();
    renderState(
      {
        status: "awaiting-input",
        form: {
          fields: [
            {
              name: "domain",
              label: "Domain",
              secret: false,
              options: [
                { value: "feishu", label: "Feishu (China · feishu.cn)" },
                { value: "lark", label: "Lark (Global · larksuite.com)" },
              ],
            },
          ],
        },
      },
      { onSubmit },
    );

    await user.click(screen.getByLabelText("Domain"));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Lark (Global · larksuite.com)",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ domain: "lark" });
  });

  it("localizes Feishu mode form and views in zh-CN while submitting raw option values", async () => {
    await i18n.changeLanguage("zh-CN");
    const onSubmit = rs.fn();
    const user = userEvent.setup();
    renderState(
      {
        status: "awaiting-input",
        form: {
          id: "feishu.mode",
          instructions: "English fallback instructions",
          fields: [
            {
              name: "mode",
              label: "Setup method",
              secret: false,
              options: [
                { value: "agent-ready", label: "Agent-ready (scan QR code)" },
                { value: "manual", label: "Manual (App ID & App Secret)" },
              ],
            },
            {
              name: "domain",
              label: "Domain",
              secret: false,
              options: [
                { value: "feishu", label: "Feishu (China · feishu.cn)" },
                { value: "lark", label: "Lark (Global · larksuite.com)" },
              ],
            },
          ],
        },
      },
      { onSubmit },
    );

    expect(screen.getByText(/选择连接方式：自动创建会通过扫码在你的飞书/)).toBeTruthy();

    await user.click(screen.getByLabelText("连接方式"));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "自动创建（扫码创建应用）",
      }),
    );
    await user.click(screen.getByLabelText("服务区域"));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "飞书（中国大陆 · feishu.cn）",
      }),
    );
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(onSubmit).toHaveBeenCalledWith({ mode: "agent-ready", domain: "feishu" });
  });

  it("localizes parameterized setup views in zh-CN", async () => {
    await i18n.changeLanguage("zh-CN");
    renderState({
      status: "done",
      grant: {
        summary: {
          id: "feishu.connected",
          params: { appId: "cli_123" },
          title: "Feishu connected",
          body: [{ id: "ready", text: "App cli_123 is live." }],
        },
      },
    });

    expect(screen.getByText("飞书已连接")).toBeTruthy();
    expect(screen.getByText(/应用 cli_123 已就绪/)).toBeTruthy();
  });

  it("resolves named view body keys independent of position and formats ISO expiresAt", async () => {
    await i18n.changeLanguage("zh-CN");
    const expiresAt = "2026-11-27T18:00:00.000Z";
    const expectedTime = new Intl.DateTimeFormat("zh-CN", { timeStyle: "short" }).format(
      new Date(expiresAt),
    );
    renderState({
      status: "presenting",
      view: {
        id: "feishu.qr",
        params: { expiresAt },
        title: "Scan to create the agent app",
        // Put `expires` first without `scan` to prove lookup is keyed by `id`, not array index.
        body: [{ id: "expires", text: `The QR code expires at ${expiresAt}.` }],
      },
    });

    expect(screen.getByText(`二维码将于 ${expectedTime} 过期。`)).toBeTruthy();
    expect(screen.queryByText(new RegExp(expiresAt))).toBeNull();
  });
});
