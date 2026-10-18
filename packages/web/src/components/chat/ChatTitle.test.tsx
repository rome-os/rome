// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ChatTitle } from "./ChatTitle";

afterEach(cleanup);

describe("ChatTitle", () => {
  it("leads with a subfolder project's whole path", () => {
    render(
      <MemoryRouter>
        <ChatTitle title="Pick a hero image" projectPath="website-redesign/assets" />
      </MemoryRouter>,
    );

    const project = screen.getByRole("link", { name: "website-redesign/assets" });
    expect(project.getAttribute("href")).toBe("/projects/website-redesign%2Fassets");
    expect(screen.getByText("Pick a hero image")).toBeTruthy();
  });
});
