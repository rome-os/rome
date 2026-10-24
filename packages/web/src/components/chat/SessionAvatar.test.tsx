// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { COARSE_POINTER_QUERY } from "@/lib/media-query";
import { SessionAvatar } from "./SessionAvatar";

rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function pointer(coarse: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query === COARSE_POINTER_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  pointer(false);
});

describe("SessionAvatar", () => {
  it("is a plain avatar when the session has no model", () => {
    render(<SessionAvatar model={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("badges the avatar with the vendor mark", () => {
    render(<SessionAvatar model="claude-opus-5-5[1m]" reasoningEffort="high" />);
    const avatar = screen.getByRole("button", { name: "navbar.sessionModelWithEffort" });
    expect(avatar.querySelector('svg[aria-label="Claude"]')).toBeTruthy();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("names the model and effort when focused", async () => {
    render(<SessionAvatar model="claude-opus-5-5[1m]" reasoningEffort="high" />);
    await act(async () => {
      screen.getByRole("button").focus();
    });
    expect(screen.getByRole("tooltip").textContent).toBe("Opus 5.5 · High");
  });

  it("opens on tap where there is no hover", async () => {
    pointer(true);
    render(<SessionAvatar model="gpt-5.6-sol" reasoningEffort="xhigh" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByRole("tooltip").textContent).toBe("GPT-5.6 Sol · Extra High");
  });
});
