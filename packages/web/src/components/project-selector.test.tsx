// @rstest-environment jsdom
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { ProjectSelector } from "./project-selector";

beforeAll(async () => {
  await i18n.changeLanguage("en");
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

  it("sets the new-project field's type from the UI role", () => {
    // Routing the field through `Input` is what keeps its typography on the
    // roster; a hand-rolled field drifts to whatever size the page picked.
    expect(renderCreateForm().className).toContain("text-ui");
  });
});

describe("project selector devices", () => {
  const folders: Record<
    string,
    { parent: string | null; entries: { name: string; type: string }[] }
  > = {
    "/Users/ray": {
      parent: "/Users",
      entries: [
        { name: "code", type: "dir" },
        { name: "link", type: "symlink" },
        { name: ".zshrc", type: "file" },
      ],
    },
    "/Users/ray/code": { parent: "/Users/ray", entries: [{ name: "rome", type: "dir" }] },
    "/Users": { parent: "/", entries: [{ name: "ray", type: "dir" }] },
  };

  const defaultDevices = [
    { id: "pc", name: "Windows PC", platform: "windows", status: "not_connected" },
    { id: "mac", name: "macbook", platform: "macos", status: "connected" },
    { id: "old", name: "old-linux", platform: "linux", status: "connected" },
    { id: "gone", name: "Revoked", platform: "linux", status: "revoked" },
  ];

  function stubDevices(
    files: (deviceId: string, path: string | null) => Response,
    devices: unknown[] = defaultDevices,
  ) {
    return rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://rome.test");
      if (url.pathname === "/api/devices") {
        return Response.json({
          connection: "online",
          checkedAt: new Date().toISOString(),
          devices,
        });
      }
      const match = url.pathname.match(/^\/api\/devices\/([^/]+)\/files$/);
      if (match) return files(match[1], url.searchParams.get("path"));
      return Response.json({ error: "unexpected" }, { status: 500 });
    }) as typeof fetch);
  }

  const macFiles = (deviceId: string, path: string | null) => {
    if (deviceId === "old") return Response.json({ error: "upgrade_required" }, { status: 409 });
    const real = path ?? "/Users/ray";
    return Response.json({ path: real, ...folders[real], truncated: false });
  };

  function Harness(
    props: Partial<ReturnType<typeof baseProps>> & {
      onPickDeviceFolder: (folder: unknown) => void;
      deviceFolder?: Parameters<typeof ProjectSelector>[0]["deviceFolder"];
    },
  ) {
    const [searchQuery, setSearchQuery] = useState("");
    return (
      <ProjectSelector
        {...baseProps()}
        {...props}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />
    );
  }

  afterEach(() => rs.restoreAllMocks());

  it("keeps the single project list when only Rome Cloud is available", async () => {
    const fetchSpy = stubDevices(macFiles, [
      { id: "gone", name: "Revoked", platform: "linux", status: "revoked" },
    ]);
    render(<Harness onPickDeviceFolder={rs.fn()} />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(await screen.findByRole("option", { name: /alpha/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Rome Cloud/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("opens on Rome Cloud and the devices, then Rome Cloud lists the projects", async () => {
    stubDevices(macFiles);
    const user = userEvent.setup();
    render(<Harness onPickDeviceFolder={rs.fn()} />);

    const rome = await screen.findByRole("option", { name: /Rome Cloud/ });
    expect(rome.textContent).toContain("general");
    expect(screen.queryByRole("option", { name: /alpha/ })).toBeNull();
    await user.click(rome);
    expect(await screen.findByRole("option", { name: /alpha/ })).toBeTruthy();
    expect(screen.getByText("Create project")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("option", { name: /Rome Cloud/ })).toBeTruthy();
  });

  it("lists devices on the first level and disables offline ones with the reason", async () => {
    stubDevices(macFiles);
    render(<Harness onPickDeviceFolder={rs.fn()} />);

    const mac = await screen.findByRole("option", { name: /macbook/ });
    expect(mac.getAttribute("aria-disabled")).not.toBe("true");
    const pc = screen.getByRole("option", { name: /Windows PC/ });
    // Offline devices sort after the connected ones.
    expect(screen.getAllByRole("option").at(-1)).toBe(pc);
    expect(pc.getAttribute("aria-disabled")).toBe("true");
    expect(pc.textContent).toContain("Offline");
    expect(screen.queryByRole("option", { name: /Revoked/ })).toBeNull();
  });

  it("browses folders, goes up, and picks the current folder with its home", async () => {
    const fetchSpy = stubDevices(macFiles);
    const onPickDeviceFolder = rs.fn();
    const user = userEvent.setup();
    render(<Harness onPickDeviceFolder={onPickDeviceFolder} />);

    await user.click(await screen.findByRole("option", { name: /macbook/ }));
    // Folders and symlinks only; files are not workspaces.
    expect(await screen.findByRole("option", { name: "code" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "link" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: ".zshrc" })).toBeNull();
    expect(screen.getByRole("option", { name: /^~(?!\/)/ })).toBeTruthy();

    await user.click(screen.getByRole("option", { name: "code" }));
    expect(await screen.findByRole("option", { name: "rome" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^~\/code/ })).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/devices/mac/files?path=%2FUsers%2Fray%2Fcode",
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onPickDeviceFolder).toHaveBeenCalledWith({
      deviceId: "mac",
      deviceName: "macbook",
      path: "/Users/ray/code",
      home: "/Users/ray",
    });
  });

  it("filters the current folder with the search box and returns to the first level", async () => {
    stubDevices(macFiles);
    const user = userEvent.setup();
    render(<Harness onPickDeviceFolder={rs.fn()} />);

    await user.click(await screen.findByRole("option", { name: /macbook/ }));
    await screen.findByRole("option", { name: "code" });
    await user.type(screen.getByPlaceholderText("Search this folder…"), "li");
    expect(screen.queryByRole("option", { name: "code" })).toBeNull();
    expect(screen.getByRole("option", { name: "link" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("option", { name: /Rome Cloud/ })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search Rome Cloud and devices…")).toBeTruthy();
  });

  it("disables a device that needs a rome-node update after it answers", async () => {
    stubDevices(macFiles);
    const user = userEvent.setup();
    render(<Harness onPickDeviceFolder={rs.fn()} />);

    await user.click(await screen.findByRole("option", { name: /old-linux/ }));
    expect(
      await screen.findByText("Update rome-node on this device to browse its folders."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Back" }));
    const old = await screen.findByRole("option", { name: /old-linux/ });
    await waitFor(() => expect(old.textContent).toContain("Update rome-node"));
    expect(old.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the picked folder on the trigger and marks its device", async () => {
    stubDevices(macFiles);
    render(
      <Harness
        onPickDeviceFolder={rs.fn()}
        deviceFolder={{
          deviceId: "mac",
          deviceName: "macbook",
          path: "/Users/ray/code",
          home: "/Users/ray",
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Project" }).textContent).toContain("macbook:~/code");
    const mac = await screen.findByRole("option", { name: /macbook/ });
    expect(mac.textContent).toContain("~/code");
  });
});
