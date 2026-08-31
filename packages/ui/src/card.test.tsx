import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card.js";

afterEach(cleanup);

/** Class names on a test node, as tokens — so `bg-surface-muted` never reads as `bg-surface`. */
function classes(testId: string): string[] {
  return [...screen.getByTestId(testId).classList];
}

describe("Card", () => {
  it("renders its children on the panel surface — surface fill, hairline border, panel radius", () => {
    render(
      <Card data-testid="card">
        <CardContent>Delivery is on.</CardContent>
      </Card>,
    );

    expect(screen.getByTestId("card").textContent).toBe("Delivery is on.");
    for (const token of ["bg-surface", "border-border", "rounded-12"]) {
      expect(classes("card")).toContain(token);
    }
  });

  it("is flat — a panel carries no shadow of its own", () => {
    render(<Card data-testid="card" />);

    expect(classes("card").some((name) => name.startsWith("shadow"))).toBe(false);
  });

  it("holds the vertical inset itself, so a headerless card keeps its top padding", () => {
    render(
      <Card data-testid="card">
        <CardContent data-testid="content">Body</CardContent>
      </Card>,
    );

    // The parts pad horizontally only. Vertical padding on the parts is what
    // forces the copied shadcn cards' `p-6 pt-0` content — correct under a
    // header, no top inset at all without one.
    expect(classes("card")).toContain("py-4");
    expect(classes("content")).toEqual(["px-4"]);
  });

  it("lets a caller's own fill and radius win over the defaults", () => {
    render(<Card data-testid="card" className="rounded-none bg-surface-muted" />);

    expect(classes("card")).toContain("rounded-none");
    expect(classes("card")).toContain("bg-surface-muted");
    expect(classes("card")).not.toContain("rounded-12");
    expect(classes("card")).not.toContain("bg-surface");
  });

  it("forwards DOM attributes and the ref to the surface element", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Card ref={ref} id="delivery" aria-label="Delivery" />);

    const card = screen.getByLabelText("Delivery");
    expect(card.id).toBe("delivery");
    expect(ref.current).toBe(card);
  });

  it("exposes the card title as a heading assistive tech can navigate to", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Delivery</CardTitle>
          <CardDescription>Where the briefing lands.</CardDescription>
        </CardHeader>
      </Card>,
    );

    const title = screen.getByRole("heading", { name: "Delivery" });
    const description = screen.getByText("Where the briefing lands.");

    expect(title.tagName).toBe("H3");
    expect(title.className).toContain("text-section");
    expect(description.className).toContain("text-body");
    expect(description.className).toContain("text-muted-foreground");
  });

  it("gives a header action its own cell beside the title, not a row below it", () => {
    render(
      <Card>
        <CardHeader data-testid="header">
          <CardTitle>Delivery</CardTitle>
          <CardDescription>Where the briefing lands.</CardDescription>
          <CardAction data-testid="action">
            <button type="button">Change</button>
          </CardAction>
        </CardHeader>
      </Card>,
    );

    const action = screen.getByTestId("action");
    expect(action.parentElement).toBe(screen.getByTestId("header"));
    // The header only opens the second column when an action is present, so a
    // header without one keeps the title full-width.
    expect(classes("header")).toContain("has-data-[slot=card-action]:grid-cols-[1fr_auto]");
    expect(classes("action")).toContain("col-start-2");
  });

  it("names every part with the shadcn data-slot an app's own styles may target", () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Delivery</CardTitle>
          <CardDescription>Where the briefing lands.</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );

    const slots = [...screen.getByTestId("card").querySelectorAll("[data-slot]")].map((node) =>
      node.getAttribute("data-slot"),
    );
    expect(screen.getByTestId("card").dataset.slot).toBe("card");
    expect(slots).toEqual([
      "card-header",
      "card-title",
      "card-description",
      "card-content",
      "card-footer",
    ]);
  });

  it("composes the parts app call sites already use, in any combination", () => {
    render(
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">App status</CardTitle>
          <CardDescription>Live from the runtime.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p>Running</p>
        </CardContent>
        <CardFooter className="gap-2">
          <button type="button">Restart</button>
        </CardFooter>
      </Card>,
    );

    expect(screen.getByRole("heading", { name: "App status" }).className).toContain("text-base");
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByRole("button", { name: "Restart" })).toBeDefined();
  });
});
