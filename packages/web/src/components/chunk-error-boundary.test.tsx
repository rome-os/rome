// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import i18n from "@/i18n";
import { ChunkErrorBoundary } from "./chunk-error-boundary";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function Thrower({ error }: { error: Error }): ReactNode {
  throw error;
}

class Outer extends Component<{ children: ReactNode }, { caught: string | null }> {
  state = { caught: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { caught: error.message };
  }
  render() {
    return this.state.caught ? <p>outer caught: {this.state.caught}</p> : this.props.children;
  }
}

describe("ChunkErrorBoundary", () => {
  it("shows a reload screen when a chunk fails to load", () => {
    rs.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Loading chunk 7 failed.");
    error.name = "ChunkLoadError";
    render(
      <ChunkErrorBoundary>
        <Thrower error={error} />
      </ChunkErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("passes any other error up instead of hiding it", () => {
    rs.spyOn(console, "error").mockImplementation(() => {});
    render(
      <Outer>
        <ChunkErrorBoundary>
          <Thrower error={new Error("render bug")} />
        </ChunkErrorBoundary>
      </Outer>,
    );
    expect(screen.getByText("outer caught: render bug")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("renders its children when nothing fails", () => {
    render(
      <ChunkErrorBoundary>
        <p>fine</p>
      </ChunkErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
  });
});
