// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { ProjectSelector } from "./project-selector";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

function renderCreateForm() {
  render(
    <ProjectSelector
      t={i18n.getFixedT("en", "chat")}
      projectCatalog={{ rootPath: "/projects", defaultPath: "/projects", projects: [] }}
      projectsLoading={false}
      projectsError={null}
      draftProjectName="general"
      draftProjectLabel="general"
      defaultProjectName="general"
      menuOpen
      searchQuery=""
      setSearchQuery={rs.fn()}
      createFormOpen
      setCreateFormOpen={rs.fn()}
      newProjectName=""
      setNewProjectName={rs.fn()}
      creatingProject={false}
      connectOnCreate={false}
      setConnectOnCreate={rs.fn()}
      onToggleMenu={rs.fn()}
      onPickProject={rs.fn()}
      onCreateProject={rs.fn()}
    />,
  );

  return screen.getByPlaceholderText("New project name");
}

const catalog = {
  rootPath: "/projects",
  defaultPath: "/projects",
  projects: [
    { name: "alpha", path: "alpha" },
    { name: "beta", path: "beta" },
  ],
};

function baseProps() {
  return {
    t: i18n.getFixedT("en", "chat"),
    projectCatalog: catalog,
    projectsLoading: false,
    projectsError: null,
    draftProjectName: "general",
    draftProjectLabel: "general",
    defaultProjectName: "general",
    menuOpen: true as const,
    searchQuery: "",
    setSearchQuery: rs.fn(),
    createFormOpen: false,
    setCreateFormOpen: rs.fn(),
    newProjectName: "",
    setNewProjectName: rs.fn(),
    creatingProject: false,
    connectOnCreate: false,
    setConnectOnCreate: rs.fn(),
    onToggleMenu: rs.fn(),
    onPickProject: rs.fn(),
    onCreateProject: rs.fn(),
  };
}

function selectedOption(): string | undefined {
  return screen
    .getAllByRole("option")
    .find((o) => o.getAttribute("data-selected") === "true")
    ?.textContent?.trim();
}

describe("project selector list", () => {
  it("highlights the first project rather than the reset row once the catalog arrives", async () => {
    // The reset row is withheld while loading on purpose: mounted alone it
    // would be the only option, cmdk would select it, and that selection would
    // survive the projects arriving — leaving Enter on the reset row.
    const props = baseProps();
    const { rerender } = render(
      <ProjectSelector {...props} projectCatalog={null} projectsLoading={true} />,
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    rerender(<ProjectSelector {...props} projectCatalog={catalog} projectsLoading={false} />);

    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));
    await waitFor(() => expect(selectedOption()).toContain("alpha"));
  });

  it("moves the highlight with the arrow keys and picks the highlighted project", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<ProjectSelector {...props} />);

    screen.getByPlaceholderText("Search projects…").focus();
    await waitFor(() => expect(selectedOption()).toContain("alpha"));

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(selectedOption()).toContain("beta"));

    await user.keyboard("{Enter}");
    expect(props.onPickProject).toHaveBeenCalledWith("beta");
  });

  it("keeps the listbox its combobox points at mounted even with no options", () => {
    // cmdk's input emits aria-controls unconditionally, so unmounting the list
    // in a loading or no-match state would leave the combobox pointing at
    // nothing. The list stays mounted and simply empty instead.
    const props = baseProps();
    render(<ProjectSelector {...props} projectCatalog={null} projectsLoading={true} />);

    const controls = screen.getByRole("combobox").getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(document.getElementById(controls as string)).not.toBeNull();
  });

  it("returns focus to the field after clearing so the keyboard flow survives", async () => {
    // The clear button unmounts as the query empties. Without the handoff focus
    // would land on <body>, outside cmdk's root, and the arrow keys would stop
    // reaching the list — clearing would strand a keyboard user.
    const props = baseProps();
    const user = userEvent.setup();
    const { rerender } = render(<ProjectSelector {...props} searchQuery="al" />);

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(props.setSearchQuery).toHaveBeenCalledWith("");

    const field = screen.getByPlaceholderText("Search projects…");
    expect(document.activeElement).toBe(field);

    // The parent owns the query, so mirror the state change it would push back.
    rerender(<ProjectSelector {...props} searchQuery="" />);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Search projects…"));
  });

  it("keeps the reset row reachable below the projects", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<ProjectSelector {...props} />);

    screen.getByPlaceholderText("Search projects…").focus();
    await waitFor(() => expect(selectedOption()).toContain("alpha"));

    // `loop` wraps upward from the first project straight onto the reset row.
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(selectedOption()).toContain("general"));

    await user.keyboard("{Enter}");
    expect(props.onPickProject).toHaveBeenCalledWith("general");
  });
});

describe("project selector create form", () => {
  it("submits on Enter even though the form sits inside the popover", async () => {
    // The form is deliberately outside <Command>, whose root would otherwise
    // consume Enter to activate the highlighted project.
    const props = baseProps();
    const user = userEvent.setup();
    render(<ProjectSelector {...props} createFormOpen newProjectName="launch-plan" />);

    screen.getByPlaceholderText("New project name").focus();
    await user.keyboard("{Enter}");

    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
    expect(props.onPickProject).not.toHaveBeenCalled();
  });

  it("sets the new-project field's type from the Body role", () => {
    // Routing the field through `Input` is what keeps its typography on the
    // roster; a hand-rolled field drifts to whatever size the page picked.
    expect(renderCreateForm().className).toContain("text-body");
  });
});
