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
    { id: "mac", name: "macbook", platform: "macos" },
    { id: "old", name: "old-linux", platform: "linux" },
    { id: "pc", name: "Windows PC", platform: "windows" },
  ];

  function stubDevices(files: (deviceId: string, path: string | null) => Response) {
    return rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://rome.test");
      const match = url.pathname.match(/^\/api\/devices\/([^/]+)\/files$/);
      if (match) return files(match[1], url.searchParams.get("path"));
      return Response.json({ error: "unexpected" }, { status: 500 });
    }) as typeof fetch);
  }

  const macFiles = (deviceId: string, path: string | null) => {
    if (deviceId === "old") return Response.json({ error: "upgrade_required" }, { status: 409 });
    if (deviceId === "pc") return Response.json({ error: "offline" }, { status: 503 });
    const real = path ?? "/Users/ray";
    return Response.json({ path: real, ...folders[real], truncated: false });
  };

  function Harness(
    props: Partial<ReturnType<typeof baseProps>> & {
      onPickDeviceFolder: (folder: unknown) => void;
      deviceFolder?: Parameters<typeof ProjectSelector>[0]["deviceFolder"];
      devices?: Parameters<typeof ProjectSelector>[0]["devices"];
    },
  ) {
    const [searchQuery, setSearchQuery] = useState("");
    return (
      <ProjectSelector
        {...baseProps()}
        {...props}
        devices={props.devices === undefined ? defaultDevices : props.devices}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />
    );
  }

  afterEach(() => rs.restoreAllMocks());

  it("keeps the single project list when only Rome Cloud is available", async () => {
    const fetchSpy = stubDevices(macFiles);
    for (const devices of [[], null]) {
      const { unmount } = render(<Harness onPickDeviceFolder={rs.fn()} devices={devices} />);
      expect(await screen.findByRole("option", { name: /alpha/ })).toBeTruthy();
      expect(screen.queryByRole("option", { name: /Rome Cloud/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
      unmount();
    }
    // No device is asked anything.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("holds the first level with placeholder devices until the locations arrive", async () => {
    stubDevices(macFiles);
    const { rerender } = render(
      <Harness
        onPickDeviceFolder={rs.fn()}
        projectCatalog={null}
        projectsLoading={true}
        devices={null}
      />,
    );
    // The final shape from the first frame: Rome Cloud, then the devices to come.
    expect(screen.getByRole("option", { name: /Rome Cloud/ })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Loading devices…");
    expect(screen.queryByText("Loading projects...")).toBeNull();
    expect(screen.queryByText("Create project")).toBeNull();

    rerender(<Harness onPickDeviceFolder={rs.fn()} />);
    expect(screen.getByRole("option", { name: /macbook/ })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
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

  it("probes a device only when it is opened, then disables it if offline", async () => {
    const fetchSpy = stubDevices(macFiles);
    const user = userEvent.setup();
    render(<Harness onPickDeviceFolder={rs.fn()} />);

    // Every device starts openable: the list carries no online status.
    const pc = await screen.findByRole("option", { name: /Windows PC/ });
    expect(pc.getAttribute("aria-disabled")).not.toBe("true");
    const urls = () => fetchSpy.mock.calls.map(([input]) => String(input));
    expect(urls().some((url) => url.includes("/files"))).toBe(false);

    await user.click(pc);
    expect(await screen.findByText("The device is offline.")).toBeTruthy();
    expect(urls().filter((url) => url.includes("/files"))).toEqual(["/api/devices/pc/files"]);
    await user.click(screen.getByRole("button", { name: "Back" }));
    const offline = await screen.findByRole("option", { name: /Windows PC/ });
    expect(offline.getAttribute("aria-disabled")).toBe("true");
    expect(offline.textContent).toContain("Offline");
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

  describe("in the Mac app", () => {
    type Status = { state: string; deviceId: string; name: string };
    function stubApp(status: Status, pickFolder?: (path?: string) => Promise<unknown>) {
      window.rome = {
        device: {
          get: async () => status,
          setEnabled: async () => status,
          onStatus: () => () => undefined,
          ...(pickFolder ? { pickFolder: rs.fn(pickFolder) } : {}),
        },
      };
      return (window.rome as { device: { pickFolder?: ReturnType<typeof rs.fn> } }).device;
    }
    const connectedMac = { state: "connected", deviceId: "mac", name: "macbook" };
    const filesCalls = (fetchSpy: ReturnType<typeof stubDevices>) =>
      fetchSpy.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/files"));

    afterEach(() => {
      delete window.rome;
    });

    it("marks this computer and lists it first", async () => {
      stubDevices(macFiles);
      stubApp({ state: "connected", deviceId: "pc", name: "Windows PC" }, async () => null);
      render(<Harness onPickDeviceFolder={rs.fn()} />);

      const pc = await screen.findByRole("option", { name: /Windows PC/ });
      await waitFor(() => expect(pc.textContent).toContain("This device"));
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        expect.stringContaining("Rome Cloud"),
        expect.stringContaining("Windows PC"),
        "macbook",
        "old-linux",
      ]);
    });

    it("picks a folder on this computer with the system dialog", async () => {
      const fetchSpy = stubDevices(macFiles);
      const device = stubApp(connectedMac, async () => ({
        path: "/Users/ray/code/rome",
        home: "/Users/ray",
      }));
      const onPickDeviceFolder = rs.fn();
      const user = userEvent.setup();
      render(<Harness onPickDeviceFolder={onPickDeviceFolder} />);

      const mac = await screen.findByRole("option", { name: /macbook/ });
      await waitFor(() => expect(mac.textContent).toContain("This device"));
      await user.click(mac);
      await waitFor(() =>
        expect(onPickDeviceFolder).toHaveBeenCalledWith({
          deviceId: "mac",
          deviceName: "macbook",
          path: "/Users/ray/code/rome",
          home: "/Users/ray",
        }),
      );
      expect(device.pickFolder).toHaveBeenCalledWith(undefined);
      expect(filesCalls(fetchSpy)).toEqual([]);
    });

    it("stays on the first level when the dialog is cancelled", async () => {
      stubDevices(macFiles);
      stubApp(connectedMac, async () => null);
      const onPickDeviceFolder = rs.fn();
      const user = userEvent.setup();
      render(<Harness onPickDeviceFolder={onPickDeviceFolder} />);

      const mac = await screen.findByRole("option", { name: /macbook/ });
      await waitFor(() => expect(mac.textContent).toContain("This device"));
      await user.click(mac);
      expect(await screen.findByRole("option", { name: /Rome Cloud/ })).toBeTruthy();
      expect(onPickDeviceFolder).not.toHaveBeenCalled();
    });

    it("opens the dialog at the folder already picked on this computer", async () => {
      stubDevices(macFiles);
      const device = stubApp(connectedMac, async () => null);
      const user = userEvent.setup();
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

      const mac = await screen.findByRole("option", { name: /macbook/ });
      await waitFor(() => expect(mac.textContent).toContain("This device"));
      await user.click(mac);
      await waitFor(() => expect(device.pickFolder).toHaveBeenCalledWith("/Users/ray/code"));
    });

    it("browses this computer in the menu while Rome cannot reach it", async () => {
      const fetchSpy = stubDevices(macFiles);
      const device = stubApp({ ...connectedMac, state: "disabled" }, async () => null);
      const user = userEvent.setup();
      render(<Harness onPickDeviceFolder={rs.fn()} />);

      const mac = await screen.findByRole("option", { name: /macbook/ });
      await waitFor(() => expect(mac.textContent).toContain("This device"));
      await user.click(mac);
      expect(await screen.findByRole("option", { name: "code" })).toBeTruthy();
      expect(device.pickFolder).not.toHaveBeenCalled();
      expect(filesCalls(fetchSpy)).toEqual(["/api/devices/mac/files"]);
    });

    it("browses in the menu when the app has no dialog or the dialog fails", async () => {
      stubDevices(macFiles);
      stubApp(connectedMac);
      const user = userEvent.setup();
      const { unmount } = render(<Harness onPickDeviceFolder={rs.fn()} />);
      const mac = await screen.findByRole("option", { name: /macbook/ });
      await waitFor(() => expect(mac.textContent).toContain("This device"));
      await user.click(mac);
      expect(await screen.findByRole("option", { name: "code" })).toBeTruthy();
      unmount();

      stubApp(connectedMac, async () => {
        throw new Error("device:pickFolder is not available to this page");
      });
      render(<Harness onPickDeviceFolder={rs.fn()} />);
      const again = await screen.findByRole("option", { name: /macbook/ });
      await waitFor(() => expect(again.textContent).toContain("This device"));
      await user.click(again);
      expect(await screen.findByRole("option", { name: "code" })).toBeTruthy();
    });
  });
});
