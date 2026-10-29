// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import i18n from "@/i18n";
import { UsageUpdatedAt } from "./usage-updated-at";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("UsageUpdatedAt", () => {
  it.each([
    [20_000, "Updated just now"],
    [5 * 60_000, "Updated 5 min ago"],
    [3 * 60 * 60_000 + 10 * 60_000, "Updated 3 h ago"],
  ])("labels a check %i ms old as %s", (age, label) => {
    render(<UsageUpdatedAt checkedAt={ago(age)} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("renders nothing without a valid check time", () => {
    const { container } = render(<UsageUpdatedAt checkedAt="not a date" />);
    expect(container.textContent).toBe("");
  });
});
