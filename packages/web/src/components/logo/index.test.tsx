// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render } from "@testing-library/react";
import { RomeLogo } from "./index";

afterEach(cleanup);

describe("RomeLogo", () => {
  it("keeps the background-filled face and unmasked body by default", () => {
    const { container } = render(<RomeLogo />);
    expect(container.querySelector('path[fill="var(--background)"]')).toBeTruthy();
    expect(container.querySelector("mask")).toBeNull();
    expect(container.querySelector("[mask]")).toBeNull();
  });

  it("cuts through the body behind a transparent face with an independent mask per logo", () => {
    const { container } = render(
      <>
        <RomeLogo cutoutFace />
        <RomeLogo cutoutFace />
      </>,
    );
    const masks = [...container.querySelectorAll("mask")];
    expect(masks).toHaveLength(2);
    expect(masks[0].id).not.toBe(masks[1].id);
    for (const mask of masks) {
      const svg = mask.closest("svg");
      const face = svg?.querySelector('svg > path[fill="none"]');
      expect(face).toBeTruthy();
      expect(mask.querySelector("path")?.getAttribute("d")).toBe(face?.getAttribute("d"));
      expect(mask.querySelector("rect")?.getAttribute("fill")).toBe("white");
      expect(mask.querySelector("path")?.getAttribute("fill")).toBe("black");
      expect(svg?.querySelectorAll(`[mask="url(#${mask.id})"]`)).toHaveLength(3);
      expect(svg?.querySelector('path[fill="var(--background)"]')).toBeNull();
    }
  });
});
