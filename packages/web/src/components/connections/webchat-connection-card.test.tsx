// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { WebchatConnectionCard } from "@/components/connections/webchat-connection-card";
import { buildConnectionCards, type ConnectionCard } from "@/lib/connection-cards";
import type { ApiConnection } from "@/lib/connections-api";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

// Webchat is a zero-grant registry connection; the presentation adapter
// synthesizes its single always-authorized slot.
const webchatConnection: ApiConnection = {
  id: "conn-webchat",
  service: "webchat",
  label: "Webchat",
  grants: {},
  display: {},
  capabilities: {
    talk: { state: "unlocked" },
    act: { state: "unsupported" },
    watch: { state: "unsupported" },
  },
  connect: null,
};

function webchatCard(): ConnectionCard {
  const card = buildConnectionCards([webchatConnection]).find(
    (entry) => entry.service === "webchat",
  );
  if (!card) throw new Error("no webchat card");
  return card;
}

describe("WebchatConnectionCard", () => {
  it("renders as a permanently-connected card with ✓ bullets and no Disconnect", () => {
    render(<WebchatConnectionCard card={webchatCard()} />);

    // Copy title + connected enablement heading + bullet.
    expect(screen.getByText("Dashboard chat")).toBeTruthy();
    expect(screen.getByText("This connection lets your agent")).toBeTruthy();
    expect(screen.getByText("Chat with your agent right here in the dashboard")).toBeTruthy();

    // Always-on confirmation line replaces any ceremony.
    expect(screen.getByText("Always on — nothing to configure.")).toBeTruthy();

    // No connect/disconnect controls.
    expect(screen.queryByRole("button")).toBeNull();
  });
});
