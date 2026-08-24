// @vitest-environment jsdom
//
// Standard renderers plus the per-(service, state) custom registry.
// Each state kind renders from its server-authored payload alone; a custom
// component overrides rendering only for its (service, status) pair.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SetupRenderer, type SetupRenderProps } from "@/components/setup/setup-renderer";
import type { SetupState } from "@/lib/setup-api";

beforeAll(() => {
  // Radix/jsdom polyfills for the pointer/scroll events Select relies on.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  delete window.rome;
});

/** What `isElectronShell` reads: the desktop preload's bridge, absent in a browser. */
function asDesktopApp() {
  window.rome = {};
}

function renderState(state: SetupState, over: Partial<SetupRenderProps> = {}) {
  const props: SetupRenderProps = {
    service: "discord",
    state,
    busy: false,
    error: null,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
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
  it("awaiting-input renders the form and submits typed answers", () => {
    const onSubmit = vi.fn();
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
    const onSubmit = vi.fn();
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
    const onCancel = vi.fn();
    renderState(
      { status: "presenting", view: { title: "Link your account", body: ["Message the bot"] } },
      { onCancel },
    );
    expect(screen.getByText("Link your account")).toBeTruthy();
    expect(screen.getByText("Message the bot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("presenting renders a QR payload as an image (WeChat/WhatsApp QR conferral)", () => {
    renderState({
      status: "presenting",
      view: {
        title: "Scan with WeChat",
        qr: "data:image/png;base64,abc",
        links: [{ label: "Open QR link", url: "https://weixin.qq.com/x" }],
      },
    });
    const img = screen.getByAltText("Scan with WeChat") as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,abc");
    expect(screen.getByRole("link", { name: "Open QR link" })).toBeTruthy();
  });

  it("done renders the summary view", () => {
    renderState({ status: "done", conferral: { summary: { title: "Discord connected" } } });
    expect(screen.getByText("Discord connected")).toBeTruthy();
  });

  it("failed renders the reason and a retry", () => {
    const onRetry = vi.fn();
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

describe("SetupRenderer custom registry", () => {
  it("uses a custom component for a matching (service, status), else the standard renderer", () => {
    const Custom = (_props: SetupRenderProps) => <div>custom-discord-presenting</div>;
    render(
      <SetupRenderer
        service="discord"
        state={{ status: "presenting", view: { title: "std" } }}
        busy={false}
        error={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        registry={{ "discord:presenting": Custom }}
      />,
    );
    expect(screen.getByText("custom-discord-presenting")).toBeTruthy();
    expect(screen.queryByText("std")).toBeNull();
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
