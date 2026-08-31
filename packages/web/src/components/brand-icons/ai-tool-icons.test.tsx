// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ModelProviderIcon, resolveModelProviderBrand } from "./ai-tool-icons";

afterEach(cleanup);

describe("ModelProviderIcon", () => {
  it("prefers the model brand over an API-compatible provider", () => {
    expect(resolveModelProviderBrand({ model: "MiniMax-M2.7", provider: "anthropic" })).toEqual({
      kind: "image",
      src: "/provider-logos/minimax.svg",
    });

    const { container } = render(<ModelProviderIcon model="MiniMax-M2.7" provider="anthropic" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/provider-logos/minimax.svg");
  });

  it("uses the existing inline brand marks for first-party model families", () => {
    const { container } = render(<ModelProviderIcon model="gpt-5.6-sol" provider="openai" />);
    expect(container.querySelector('svg[aria-label="ChatGPT"]')).toBeTruthy();
  });

  it("can use the Rome mark as the generic model fallback", () => {
    const { container } = render(
      <ModelProviderIcon model="unknown-model" provider={null} fallback="rome" />,
    );
    expect(container.querySelector('svg[viewBox="0 0 51 48"]')).toBeTruthy();
    expect(container.querySelector('[data-lucide="cpu"]')).toBeNull();
  });
});
