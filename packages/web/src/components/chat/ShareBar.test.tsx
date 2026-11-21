// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@/i18n";
import { createShare } from "@/lib/chat-api";
import type { GatedFeature } from "@rome/api-types/features";
import { hiddenFeatures, isShownInTest } from "@/test/features";
import { ShareBar } from "./ShareBar";

const placements: { id: string; type: string; targetId?: string; order: number }[] = [
  { id: "w-app", type: "app", targetId: "studio", order: 1 },
  { id: "w-projects", type: "projects", order: 2 },
];

rs.mock("@/pages/free/use-free-cells", () => ({ useFreeCells: () => ({ placements }) }));
rs.mock("@/lib/features", () => ({
  isShown: (feature?: GatedFeature) => isShownInTest(feature),
}));
rs.mock("@/hooks/use-apps", () => ({
  useAppsList: () => ({ apps: [{ id: "studio", displayName: "Studio", iconUrl: null }] }),
}));
rs.mock("@/lib/chat-api", () => ({
  ChatApiError: class extends Error {},
  createShare: rs.fn(),
  getSession: rs.fn(),
  listShares: rs.fn(),
  revokeShare: rs.fn(),
}));

beforeEach(async () => {
  const api = await import("@/lib/chat-api");
  rs.mocked(api.getSession).mockResolvedValue(null);
  rs.mocked(api.listShares).mockResolvedValue([]);
  rs.mocked(createShare).mockResolvedValue({ id: "tok", url: "/share/tok", title: "Plan" });
});
afterEach(() => {
  hiddenFeatures.clear();
  cleanup();
  rs.clearAllMocks();
});

describe("ShareBar", () => {
  it("includes app tiles but leaves the project workspace out until its owner opts in", async () => {
    render(<ShareBar sessionId="s" selectedTurnIds={["t1"]} agentName="Flint" onExit={() => {}} />);
    const app = screen.getByRole("switch", { name: "Studio" });
    const projects = screen.getByRole("switch", { name: "Project workspace" });
    expect(app.getAttribute("aria-checked")).toBe("true");
    expect(projects.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/Exposes every file in this project/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(createShare).toHaveBeenCalledWith("s", {
        turnIds: ["t1"],
        layout: [placements[0]],
        agentName: "Flint",
      }),
    );

    fireEvent.click(projects);
    expect(projects.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Exposes every file in this project/)).toBeTruthy();
  });

  it("offers no saved widget of a hidden feature's app, and leaves it out of the link", async () => {
    hiddenFeatures.add("inbox");
    placements.push({ id: "w-inbox", type: "app", targetId: "inbox", order: 3 });
    try {
      render(
        <ShareBar sessionId="s" selectedTurnIds={["t1"]} agentName="Flint" onExit={() => {}} />,
      );
      expect(screen.getAllByRole("switch")).toHaveLength(2);
      expect(screen.queryByRole("switch", { name: "inbox" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Create link" }));
      await waitFor(() =>
        expect(createShare).toHaveBeenCalledWith("s", {
          turnIds: ["t1"],
          layout: [placements[0]],
          agentName: "Flint",
        }),
      );
    } finally {
      placements.pop();
    }
  });
});
