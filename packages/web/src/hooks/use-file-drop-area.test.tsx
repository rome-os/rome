// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { useFileDropArea } from "./use-file-drop-area";

function Area({
  onActiveChange,
  onDrop,
  refuse,
}: {
  onActiveChange: (active: boolean) => void;
  onDrop: () => void;
  refuse?: () => boolean;
}) {
  const { dropAreaProps } = useFileDropArea({ onActiveChange, onDrop, refuse });
  return (
    <div data-testid="area" {...dropAreaProps}>
      <span data-testid="child">child</span>
      {/* A child that handles its own drop, like a folder in the file tree. */}
      <span data-testid="folder" onDrop={(event) => event.stopPropagation()}>
        folder
      </span>
    </div>
  );
}

const files = { dataTransfer: { types: ["Files"], files: [], items: [], dropEffect: "" } };
const text = { dataTransfer: { types: ["text/plain"], files: [], items: [], dropEffect: "" } };

function setup(refuse?: () => boolean) {
  const onActiveChange = rs.fn();
  const onDrop = rs.fn();
  render(<Area onActiveChange={onActiveChange} onDrop={onDrop} refuse={refuse} />);
  return { onActiveChange, onDrop };
}

describe("useFileDropArea", () => {
  afterEach(cleanup);

  it("stays active while files cross from the area into a child and back", () => {
    const { onActiveChange } = setup();
    fireEvent.dragEnter(screen.getByTestId("area"), files);
    fireEvent.dragEnter(screen.getByTestId("child"), files);
    fireEvent.dragLeave(screen.getByTestId("area"), files);
    expect(onActiveChange.mock.calls).toEqual([[true]]);
    fireEvent.dragLeave(screen.getByTestId("child"), files);
    expect(onActiveChange.mock.calls).toEqual([[true], [false]]);
  });

  it("drops the files and ends the drag", () => {
    const { onActiveChange, onDrop } = setup();
    fireEvent.dragEnter(screen.getByTestId("child"), files);
    fireEvent.drop(screen.getByTestId("child"), files);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onActiveChange.mock.calls).toEqual([[true], [false]]);
  });

  it("ends the drag when a child takes the drop, so the next drag starts clean", () => {
    const { onActiveChange, onDrop } = setup();
    fireEvent.dragEnter(screen.getByTestId("area"), files);
    fireEvent.dragEnter(screen.getByTestId("folder"), files);
    fireEvent.drop(screen.getByTestId("folder"), files);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onActiveChange.mock.calls).toEqual([[true], [false]]);

    fireEvent.dragEnter(screen.getByTestId("area"), files);
    fireEvent.dragLeave(screen.getByTestId("area"), files);
    expect(onActiveChange.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("ignores drags that carry no files", () => {
    const { onActiveChange, onDrop } = setup();
    fireEvent.dragEnter(screen.getByTestId("area"), text);
    fireEvent.drop(screen.getByTestId("area"), text);
    expect(onActiveChange).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("refuses files while refuse holds", () => {
    const { onActiveChange, onDrop } = setup(() => true);
    fireEvent.dragEnter(screen.getByTestId("area"), files);
    fireEvent.drop(screen.getByTestId("area"), files);
    expect(onActiveChange.mock.calls.filter(([active]) => active)).toEqual([]);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
