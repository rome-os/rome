// @rstest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import {
  FileActionDropdownMenuItems,
  FileActionSheet,
  getFileActionMenuEntries,
  type ContextMenuActions,
} from "./file-browser/ContextMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { shouldAllowNativeTreeDrag } from "./file-browser/Tree";
import { LONG_PRESS_MOVE_TOLERANCE_PX, LONG_PRESS_MS } from "@/hooks/use-long-press-menu";
import { FileGridCard, FileRow, type FilesPaneNode } from "./files-pane";

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
  }
}

const fileNode: FilesPaneNode = {
  name: "notes.md",
  path: "/projects/notes.md",
  type: "file",
};

function createActions(): ContextMenuActions {
  return {
    creating: false,
    renaming: false,
    moving: false,
    deleting: false,
    logicalRootPath: "/projects",
    rootLabel: "projects",
    canStartChatFromFolder: true,
    onCreatePath: rs.fn(),
    onCopyPath: rs.fn(),
    onDownloadPaths: rs.fn(),
    onUploadForFolder: rs.fn(),
    onUploadFolderForFolder: rs.fn(),
    onStartChatHere: rs.fn(),
    onRenamePath: rs.fn(),
    onRequestMovePath: rs.fn(),
    onRequestDeletePaths: rs.fn(),
    labelSelectedItems: (count) => `${count} selected`,
    labelNewFile: "New file",
    labelNewFolder: "New folder",
    labelCopyPath: "Copy path",
    labelDownload: "Download",
    labelUploadFiles: "Upload files",
    labelUploadFolder: "Upload folder",
    labelStartChatHere: "Start chat here",
    labelRename: "Rename",
    labelMoveTo: "Move to…",
    labelDelete: "Delete",
    labelMoreActions: (name) => `More actions for ${name}`,
    labelActionsFor: (name) => `Actions for ${name}`,
    labelCloseActions: "Close actions",
  };
}

beforeAll(() => {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: TestPointerEvent,
  });
});

afterEach(() => {
  cleanup();
  rs.useRealTimers();
});

describe("compact file item actions", () => {
  it("opens from the visible action button without selecting the file", () => {
    const onSelect = rs.fn();
    const onOpenActions = rs.fn();
    render(
      <FileRow
        node={fileNode}
        onSelect={onSelect}
        onOpenActions={onOpenActions}
        actions={createActions()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for notes.md" }));

    expect(onOpenActions).toHaveBeenCalledWith(fileNode);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens after a touch long-press and suppresses the release click", () => {
    rs.useFakeTimers();
    const onSelect = rs.fn();
    const onOpenActions = rs.fn();
    render(
      <FileRow
        node={fileNode}
        onSelect={onSelect}
        onOpenActions={onOpenActions}
        actions={createActions()}
      />,
    );
    const fileButton = screen.getByRole("button", { name: "notes.md" });

    fireEvent.pointerDown(fileButton, { pointerType: "touch" });
    act(() => rs.advanceTimersByTime(LONG_PRESS_MS));
    expect(onOpenActions).toHaveBeenCalledWith(fileNode);

    fireEvent.pointerUp(fileButton, { pointerType: "touch" });
    fireEvent.click(fileButton);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("cancels long-press when the pointer moves or lifts early", () => {
    rs.useFakeTimers();
    const onOpenActions = rs.fn();
    const { rerender } = render(
      <FileRow
        node={fileNode}
        onSelect={rs.fn()}
        onOpenActions={onOpenActions}
        actions={createActions()}
      />,
    );
    let fileButton = screen.getByRole("button", { name: "notes.md" });

    fireEvent.pointerDown(fileButton, { pointerType: "touch", clientX: 0, clientY: 0 });
    fireEvent.pointerMove(fileButton, {
      pointerType: "touch",
      clientX: LONG_PRESS_MOVE_TOLERANCE_PX + 1,
      clientY: 0,
    });
    act(() => rs.advanceTimersByTime(LONG_PRESS_MS));
    expect(onOpenActions).not.toHaveBeenCalled();

    rerender(
      <FileRow
        node={fileNode}
        onSelect={rs.fn()}
        onOpenActions={onOpenActions}
        actions={createActions()}
      />,
    );
    fileButton = screen.getByRole("button", { name: "notes.md" });
    fireEvent.pointerDown(fileButton, { pointerType: "pen" });
    fireEvent.pointerUp(fileButton, { pointerType: "pen" });
    act(() => rs.advanceTimersByTime(LONG_PRESS_MS));
    expect(onOpenActions).not.toHaveBeenCalled();
  });

  it("opens from desktop contextmenu without suppressing a later click", () => {
    const onSelect = rs.fn();
    const onOpenActions = rs.fn();
    render(
      <FileRow
        node={fileNode}
        onSelect={onSelect}
        onOpenActions={onOpenActions}
        actions={createActions()}
      />,
    );
    const fileButton = screen.getByRole("button", { name: "notes.md" });
    const row = fileButton.parentElement;
    expect(row).not.toBeNull();

    fireEvent.pointerDown(fileButton, { pointerType: "mouse" });
    const contextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row?.dispatchEvent(contextEvent);
    expect(contextEvent.defaultPrevented).toBe(true);
    expect(onOpenActions).toHaveBeenCalledWith(fileNode);

    fireEvent.click(fileButton);
    expect(onSelect).toHaveBeenCalledWith(fileNode);
  });

  it("does not suppress a later mouse click after a touch press leaves the row", () => {
    rs.useFakeTimers();
    const onSelect = rs.fn();
    const onOpenActions = rs.fn();
    render(
      <FileRow
        node={fileNode}
        onSelect={onSelect}
        onOpenActions={onOpenActions}
        actions={createActions()}
      />,
    );
    const fileButton = screen.getByRole("button", { name: "notes.md" });
    const row = fileButton.parentElement;
    expect(row).not.toBeNull();

    // A touch press that wanders off the row, then a plain desktop right-click
    // later: the press is over, so the click that follows belongs to the user.
    fireEvent.pointerDown(fileButton, { pointerType: "touch" });
    fireEvent.pointerLeave(row as HTMLElement, { pointerType: "touch" });
    act(() => rs.advanceTimersByTime(LONG_PRESS_MS));
    expect(onOpenActions).not.toHaveBeenCalled();

    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onOpenActions).toHaveBeenCalledWith(fileNode);

    fireEvent.click(fileButton);
    expect(onSelect).toHaveBeenCalledWith(fileNode);
  });

  it("keeps grid cards clean while preserving touch long-press actions", () => {
    rs.useFakeTimers();
    const onOpenActions = rs.fn();
    render(<FileGridCard node={fileNode} onSelect={rs.fn()} onOpenActions={onOpenActions} />);
    const fileButton = screen.getByRole("button", { name: "notes.md" });

    expect(screen.queryByRole("button", { name: "More actions for notes.md" })).toBeNull();
    fireEvent.pointerDown(fileButton, { pointerType: "touch" });
    act(() => rs.advanceTimersByTime(LONG_PRESS_MS));
    expect(onOpenActions).toHaveBeenCalledWith(fileNode);
  });
});

describe("shared file action model", () => {
  it("keeps folder actions and destructive separation consistent across renderers", () => {
    const entries = getFileActionMenuEntries({
      kind: "directory",
      path: "/projects/example",
      paths: ["/projects/example"],
      actions: createActions(),
    });

    expect(entries.map((entry) => entry.key)).toEqual([
      "new-file",
      "new-folder",
      "copy-path",
      "download",
      "upload-files",
      "upload-folder",
      "start-chat",
      "rename",
      "move-to",
      "destructive-separator",
      "delete",
    ]);
  });

  it("allows native tree drag only for the active mouse pointer", () => {
    expect(shouldAllowNativeTreeDrag("mouse")).toBe(true);
    expect(shouldAllowNativeTreeDrag("touch")).toBe(false);
    expect(shouldAllowNativeTreeDrag("pen")).toBe(false);
  });

  it("renders the shared actions in the compact action sheet", () => {
    const actions = createActions();
    const onClose = rs.fn();
    render(
      <FileActionSheet
        open
        title="Actions for notes.md"
        closeLabel="Close actions"
        kind="file"
        path={fileNode.path}
        paths={[fileNode.path]}
        actions={actions}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Actions for notes.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(actions.onRenamePath).toHaveBeenCalledWith(fileNode.path);
  });

  it("marks destructive entries the same way in the sheet and the dropdown", () => {
    render(
      <FileActionSheet
        open
        title="Actions for notes.md"
        closeLabel="Close actions"
        kind="file"
        path={fileNode.path}
        paths={[fileNode.path]}
        actions={createActions()}
        onClose={rs.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Delete" }).dataset.variant).toBe("destructive");
    expect(screen.getByRole("button", { name: "Rename" }).dataset.variant).toBe("default");
    cleanup();

    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <FileActionDropdownMenuItems
            kind="file"
            path={fileNode.path}
            paths={[fileNode.path]}
            actions={createActions()}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.getByRole("menuitem", { name: "Delete" }).dataset.variant).toBe("destructive");
    expect(screen.getByRole("menuitem", { name: "Rename" }).dataset.variant).toBe("default");
  });

  it("keeps the sheet's 48px touch target rather than the dropdown's density", () => {
    render(
      <FileActionSheet
        open
        title="Actions for notes.md"
        closeLabel="Close actions"
        kind="file"
        path={fileNode.path}
        paths={[fileNode.path]}
        actions={createActions()}
        onClose={rs.fn()}
      />,
    );

    // No layout in jsdom, so the 48px floor is only observable as the class
    // that sets it — which is exactly the regression to guard: collapsing the
    // sheet onto the shared row must not shrink it to desktop density.
    expect(screen.getByRole("button", { name: "Rename" }).className).toContain("min-h-12");
  });

  it("gives sheet rows a visible keyboard focus outline, not just a background tint", () => {
    render(
      <FileActionSheet
        open
        title="Actions for notes.md"
        closeLabel="Close actions"
        kind="file"
        path={fileNode.path}
        paths={[fileNode.path]}
        actions={createActions()}
        onClose={rs.fn()}
      />,
    );

    // The accent background alone is ~1.2:1 against the sheet surface, under
    // the 3:1 WCAG 1.4.11 asks of a focus indicator, so the outline carries
    // it. `outline-solid` is load-bearing: the base sets outline-hidden, which
    // zeroes --tw-outline-style, and outline-2 reads that variable.
    const row = screen.getByRole("button", { name: "Rename" }).className;
    expect(row).toContain("focus-visible:outline-solid");
    expect(row).toContain("focus-visible:outline-2");
    expect(row).toContain("focus-visible:outline-ring");
  });
});
