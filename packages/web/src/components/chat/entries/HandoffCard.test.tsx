// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { HandoffCard } from "./HandoffCard";

rs.mock("@/components/chat/AgentAvatar", () => ({
  AgentAvatar: ({ iconUrl }: { iconUrl?: string | null }) => (
    <span data-testid="avatar" data-icon={iconUrl ?? ""} />
  ),
}));

rs.mock("@/components/chat/ChatMarkdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

afterEach(() => cleanup());

describe("HandoffCard", () => {
  it.each([
    ["the main agent's avatar", "core:main", ""],
    ["the specialist app's icon", "coding:builder", "/api/apps/welcome-to-rome/icon"],
  ])("shows %s on the @mention", (_label, agentName, icon) => {
    render(
      <HandoffCard appId="welcome-to-rome" agentName={agentName} agentLabel="Nova" status="open" />,
    );
    expect(screen.getByTestId("avatar").getAttribute("data-icon")).toBe(icon);
    expect(screen.getByTestId("avatar").parentElement?.textContent).toContain("Nova");
  });

  it("names a handoff to the main agent with the guardian's current name for it", () => {
    render(
      <HandoffCard
        appId="welcome-to-rome"
        agentName="core:main"
        agentLabel="Nova"
        mainAgentName="Spark"
        status="open"
      />,
    );
    expect(screen.getByTestId("avatar").parentElement?.textContent).toContain("Spark");
    expect(screen.getByTestId("avatar").parentElement?.textContent).not.toContain("Nova");
  });

  it("keeps a specialist's own label", () => {
    render(
      <HandoffCard
        appId="coding"
        agentName="coding:builder"
        agentLabel="Builder"
        mainAgentName="Spark"
        status="open"
      />,
    );
    expect(screen.getByTestId("avatar").parentElement?.textContent).toContain("Builder");
  });
});
