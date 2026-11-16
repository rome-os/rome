// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { useRenameInPlace } from "./use-rename-in-place";

function Row({ onCommit }: { onCommit: (id: string, name: string) => void }) {
  const rename = useRenameInPlace({ onCommit });
  return rename.editingId === "c1" ? (
    <input aria-label="name" {...rename.inputProps} />
  ) : (
    <button type="button" onClick={() => rename.start("c1", "Kyoto trip")}>
      Rename
    </button>
  );
}

async function openField(onCommit = rs.fn()) {
  render(<Row onCommit={onCommit} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return { onCommit, field: screen.getByRole("textbox", { name: "name" }) as HTMLInputElement };
}

describe("useRenameInPlace", () => {
  afterEach(cleanup);

  it("opens with the current name focused and selected", async () => {
    const { field } = await openField();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Kyoto trip");
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("Kyoto trip".length);
  });

  it("commits the trimmed name on Enter, once even when the field then blurs", async () => {
    const { field, onCommit } = await openField();
    fireEvent.change(field, { target: { value: "  Osaka trip " } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("c1", "Osaka trip");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("commits when the field loses focus", async () => {
    const { field, onCommit } = await openField();
    fireEvent.change(field, { target: { value: "Osaka trip" } });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledWith("c1", "Osaka trip");
  });

  it("cancels on Escape, and on an empty or unchanged name", async () => {
    for (const [value, key] of [
      ["Osaka trip", "Escape"],
      ["   ", "Enter"],
      ["Kyoto trip", "Enter"],
    ]) {
      const { field, onCommit } = await openField();
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key });
      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.queryByRole("textbox")).toBeNull();
      cleanup();
    }
  });

  it("leaves the Enter that confirms an input method candidate alone", async () => {
    const { field, onCommit } = await openField();
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBe(field);
  });
});
