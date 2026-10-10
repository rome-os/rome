// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import "@/i18n";
import {
  AvailableToAddLabel,
  ConnectionSlotCard,
  SoleSlotScope,
} from "@/components/connection-slot-card";
import type { ConnectionSlot } from "@/lib/connection-cards";
import type { GrantState } from "@/lib/connections-api";

const slot = (
  key: ConnectionSlot["key"],
  state: GrantState,
  identity: string | null = null,
): ConnectionSlot => ({
  key,
  connectionId: "conn-1",
  grant: key === "session" ? "session" : "bot",
  state,
  display: null,
  identity,
});

afterEach(() => {
  cleanup();
});

describe("ConnectionSlotCard", () => {
  it("connected slot: solid border, ✓ heading, identity title, and the action node", () => {
    const { container } = render(
      <ConnectionSlotCard
        service="telegram"
        slot={slot("bot", "authorized", "@fujian_helper_bot")}
        state="connected"
        role="primary"
        icon={<span data-testid="icon" />}
        identityTitle="@fujian_helper_bot"
        action={<button type="button">Disconnect</button>}
      />,
    );

    // Connected identity is the title (copy yields the title to it).
    expect(screen.getByText("@fujian_helper_bot")).toBeTruthy();
    // Connected heading + ✓ bullet interpolating the identity.
    expect(screen.getByText("This connection lets your agent")).toBeTruthy();
    expect(screen.getByText("Reply when people message @fujian_helper_bot")).toBeTruthy();
    // The action node renders.
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    // Setup guidance yields to the connected-state line once connected.
    expect(screen.queryByText("Add a bot from @BotFather.")).toBeNull();
    // No identity detail means no subtitle; the dialog header already carries
    // the connected status.
    expect(screen.queryByText("Connected")).toBeNull();
    // Solid (non-dashed) border for a held credential.
    const section = container.querySelector("section");
    expect(section?.className).toContain("border-border");
    expect(section?.className).not.toContain("border-dashed");
  });

  it("unconnected primary slot: dashed border, + heading, fallback copy title, no action", () => {
    const { container } = render(
      <ConnectionSlotCard
        service="telegram"
        slot={slot("bot", "unauthorized")}
        state="unconnected"
        role="primary"
        icon={<span data-testid="icon" />}
      >
        <div data-testid="ceremony">connect controls</div>
      </ConnectionSlotCard>,
    );

    // No identity yet: falls back to the copy title and the identity-free bullets.
    expect(screen.getByText("Your Telegram bot")).toBeTruthy();
    expect(screen.getByText("This connection will let your agent")).toBeTruthy();
    expect(screen.getByText("Reply when people message your bot")).toBeTruthy();
    // Ceremony children render inside the card.
    expect(screen.getByTestId("ceremony")).toBeTruthy();
    // No action node when none is supplied.
    expect(screen.queryByRole("button")).toBeNull();
    // Dashed border for an unheld credential.
    expect(container.querySelector("section")?.className).toContain("border-dashed");
  });

  it("unconnected secondary slot: 'Adding it lets your agent also' heading", () => {
    render(
      <ConnectionSlotCard
        service="telegram"
        slot={slot("session", "unauthorized")}
        state="unconnected"
        role="secondary"
        icon={<span data-testid="icon" />}
      />,
    );

    expect(screen.getByText("Adding it lets your agent also")).toBeTruthy();
    // Secondary session slot carries subtitle + bullets.
    expect(screen.getByText("Sign in with your phone number.")).toBeTruthy();
    expect(
      screen.getByText("Send messages from your account — reach suppliers and customers as you"),
    ).toBeTruthy();
  });

  it("renders the privacy lock box only for slots that warrant one", () => {
    const { rerender } = render(
      <ConnectionSlotCard
        service="telegram"
        slot={slot("session", "unauthorized")}
        state="unconnected"
        role="secondary"
        icon={<span />}
      />,
    );

    // The session slot carries a privacyNote lock box.
    expect(
      screen.getByText(
        "Encrypted, stored only on your instance, visible in Telegram's active sessions. Disconnect anytime.",
      ),
    ).toBeTruthy();

    // The bot slot does not.
    rerender(
      <ConnectionSlotCard
        service="telegram"
        slot={slot("bot", "unauthorized")}
        state="unconnected"
        role="primary"
        icon={<span />}
      />,
    );
    expect(
      screen.queryByText(
        "Encrypted, stored only on your instance, visible in Telegram's active sessions. Disconnect anytime.",
      ),
    ).toBeNull();
  });

  it("AvailableToAddLabel renders the muted section label", () => {
    render(<AvailableToAddLabel />);
    expect(screen.getByText("Available to add")).toBeTruthy();
  });
});

describe("ConnectionSlotCard inside SoleSlotScope (single-slot connection)", () => {
  it("unconnected: drops the card chrome — no border box, no icon, no title, no setup subtitle", () => {
    const { container } = render(
      <SoleSlotScope>
        <ConnectionSlotCard
          service="telegram"
          slot={slot("bot", "unauthorized")}
          state="unconnected"
          role="primary"
          icon={<span data-testid="icon" />}
        >
          <div data-testid="ceremony">connect controls</div>
        </ConnectionSlotCard>
      </SoleSlotScope>,
    );

    // No inner card box, no duplicate brand icon, no "Your Telegram bot" title
    // echo — the dialog header already carries brand + name — and no setup
    // subtitle: the ceremony below carries the how-to. Telegram is the service
    // under test because it is the only one that carries a subtitle to drop.
    const section = container.querySelector("section");
    expect(section?.className).not.toContain("border");
    expect(screen.queryByTestId("icon")).toBeNull();
    expect(screen.queryByText("Your Telegram bot")).toBeNull();
    expect(screen.queryByText("Add a bot from @BotFather.")).toBeNull();
    // Bullets and ceremony are unchanged.
    expect(screen.getByText("This connection will let your agent")).toBeTruthy();
    expect(screen.getByTestId("ceremony")).toBeTruthy();
  });

  it("connected: the header row returns (sans icon) with identity and action", () => {
    render(
      <SoleSlotScope>
        <ConnectionSlotCard
          service="wechat"
          slot={slot("bot", "authorized", "wx_user")}
          state="connected"
          role="primary"
          icon={<span data-testid="icon" />}
          identityTitle="wx_user"
          action={<button type="button">Disconnect</button>}
        />
      </SoleSlotScope>,
    );

    expect(screen.queryByTestId("icon")).toBeNull();
    expect(screen.getByText("wx_user")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.getByText("This connection lets your agent")).toBeTruthy();
  });

  it("outside the scope the full card frame is unchanged", () => {
    const { container } = render(
      <ConnectionSlotCard
        service="wechat"
        slot={slot("bot", "unauthorized")}
        state="unconnected"
        role="primary"
        icon={<span data-testid="icon" />}
      />,
    );

    expect(container.querySelector("section")?.className).toContain("border-dashed");
    expect(screen.getByTestId("icon")).toBeTruthy();
    expect(screen.getByText("Your WeChat")).toBeTruthy();
  });
});
