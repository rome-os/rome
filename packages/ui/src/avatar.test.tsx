import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Avatar, AvatarFallback } from "./avatar.js";

afterEach(cleanup);

describe("Avatar", () => {
  it.each([
    ["sm", "data-[size=sm]:size-6"],
    ["default", "size-8"],
    ["lg", "data-[size=lg]:size-10"],
  ] as const)("renders the %s size step", (size, sizeClass) => {
    render(
      <Avatar size={size} data-testid="avatar">
        <AvatarFallback>ZF</AvatarFallback>
      </Avatar>,
    );

    const avatar = screen.getByTestId("avatar");
    expect(avatar.dataset.size).toBe(size);
    expect([...avatar.classList]).toContain(sizeClass);
  });

  it("lets dashboard consumers override its size and shape", () => {
    render(
      <Avatar className="size-9 rounded-8 after:rounded-8" data-testid="avatar">
        <AvatarFallback className="rounded-8">ZF</AvatarFallback>
      </Avatar>,
    );

    const avatar = screen.getByTestId("avatar");
    expect([...avatar.classList]).toEqual(
      expect.arrayContaining(["size-9", "rounded-8", "after:rounded-8"]),
    );
    expect([...avatar.classList]).not.toContain("size-8");
    expect([...screen.getByText("ZF").classList]).toContain("rounded-8");
  });
});
